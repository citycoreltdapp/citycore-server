import { Role } from '@/constants/roles';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import { sessionService } from '@/modules/auth/session.service';
import { ACTIVE_TICKET_STATUSES, TicketModel } from '@/modules/helpdesk/ticket.model';
import { CustomerLinkModel } from '@/modules/symplus/customerLink.model';
import { cloudinaryStorage } from '@/integrations/cloudinary/cloudinary.client';
import { verifyPassword } from '@/utils/password';
import { InvestmentSubscriptionModel } from '@/modules/investment/investmentSubscription.model';
import { KycVerificationModel } from '@/modules/kyc/kyc.model';
import { WALLET_CURRENCY, WalletModel } from '@/modules/wallet/wallet.model';
import { UserModel, type IUser } from './user.model';

class UserService extends BaseService<IUser> {
  constructor() {
    super(UserModel, {
      resourceName: 'User',
      searchFields: ['name', 'email', 'phone', 'employeeId'],
    });
  }

  findByEmailWithPassword(email: string) {
    return this.findOne({ email }, '+password');
  }

  findByIdWithPassword(id: string) {
    return this.findById(id, '+password');
  }

  /** Preferences merge, so that changing one doesn't reset the others to their defaults. */
  override async updateById(id: string, { preferences, ...data }: Partial<IUser>) {
    const user = await this.findById(id);
    user.set(data);
    for (const [key, value] of Object.entries(preferences ?? {})) {
      user.set(`preferences.${key}`, value);
    }
    await user.save();
    return user;
  }

  /** What's linked to an account. Each section is left out unless the caller may see it. */
  async getOverview(
    id: string,
    include: { wallet: boolean; banking: boolean; tickets: boolean; investments: boolean },
  ) {
    const user = await this.findById(id);
    const [wallet, link, activeTickets, totalTickets, sessions, investments] = await Promise.all([
      include.wallet ? WalletModel.findOne({ user: id }).lean().exec() : null,
      include.banking ? CustomerLinkModel.findOne({ user: id }).lean().exec() : null,
      include.tickets
        ? TicketModel.countDocuments({
            requester: id,
            status: { $in: ACTIVE_TICKET_STATUSES },
          }).exec()
        : 0,
      include.tickets ? TicketModel.countDocuments({ requester: id }).exec() : 0,
      sessionService.listActive(id),
      include.investments
        ? InvestmentSubscriptionModel.find({ user: id, status: 'active' })
            .select('amount')
            .lean()
            .exec()
        : [],
    ]);
    return {
      user,
      activeSessions: sessions.length,
      ...(include.wallet && {
        wallet: {
          balance: wallet?.balance ?? 0,
          currency: wallet?.currency ?? WALLET_CURRENCY,
          virtualAccountStatus: wallet?.virtualAccountStatus ?? 'none',
        },
      }),
      ...(include.banking && {
        coreBanking: link && {
          status: link.status,
          customerType: link.customerType,
          customerId: link.customerId,
          lastError: link.lastError,
        },
      }),
      ...(include.tickets && { tickets: { active: activeTickets, total: totalTickets } }),
      ...(include.investments && {
        investments: {
          active: investments.length,
          activePrincipal: investments.reduce((sum, { amount }) => sum + amount, 0),
        },
      }),
    };
  }

  async replaceAvatar(id: string, avatar: string) {
    const user = await this.findById(id);
    const previous = user.avatar;
    user.avatar = avatar;
    await user.save();
    await this.removeUnusedAvatar(previous);
    return user;
  }

  async removeAvatar(id: string) {
    const user = await this.findById(id);
    const previous = user.avatar;
    user.avatar = null;
    await user.save();
    await this.removeUnusedAvatar(previous);
    return user;
  }

  /** A passport photograph starts as the avatar, but reviewers still need it once it's replaced. */
  private async removeUnusedAvatar(url: string | null): Promise<void> {
    if (!url) return;
    if (await KycVerificationModel.exists({ 'passportPhoto.url': url })) return;
    await cloudinaryStorage.remove(url);
  }

  /**
   * Symplus finds a customer by their email, so a change during onboarding would lose the record,
   * and one afterwards would leave the two systems disagreeing. This applies to staff too.
   */
  async assertEmailNotLocked(id: string): Promise<void> {
    const link = await CustomerLinkModel.exists({
      user: id,
      status: { $in: ['queued', 'pending', 'active'] },
    });
    if (link) {
      throw AppError.conflict(
        'This email is tied to a core banking profile, so it cannot be changed',
        'EMAIL_LOCKED',
      );
    }
  }

  /** An account can't go while it holds money, or that money would have no owner. */
  async assertNoFundsHeld(id: string): Promise<void> {
    const wallet = await WalletModel.findOne({ user: id }).select('balance').lean().exec();
    if (wallet && wallet.balance !== 0) {
      throw AppError.conflict('This user still has a wallet balance', 'WALLET_NOT_EMPTY');
    }
    if (await InvestmentSubscriptionModel.exists({ user: id, status: 'active' })) {
      throw AppError.conflict('This user still has active investments', 'INVESTMENTS_ACTIVE');
    }
  }

  /**
   * Creates the super admin, or promotes an existing account to it. The password must match first:
   * emails aren't verified, so anyone could have registered this address before the seed ran.
   */
  async ensureSuperAdmin(data: { name: string; email: string; password: string }) {
    const existing = await this.findByEmailWithPassword(data.email);
    if (!existing) {
      await this.create({ ...data, role: Role.SUPER_ADMIN });
      return 'created' as const;
    }
    if (!existing.hasPassword || !(await verifyPassword(data.password, existing.password))) {
      throw AppError.conflict(
        'That email already has an account with a different password',
        'SEED_PASSWORD_MISMATCH',
      );
    }
    if (existing.role === Role.SUPER_ADMIN && existing.isActive) return 'unchanged' as const;

    existing.role = Role.SUPER_ADMIN;
    existing.isActive = true;
    await existing.save();
    return 'promoted' as const;
  }

  override async deleteById(id: string): Promise<void> {
    const user = await this.findById(id);

    await this.assertNoFundsHeld(id);

    await user.deleteOne();
    await sessionService.revokeAllForUser(id);
    // Only the link goes. The customer's record in Symplus isn't ours to delete.
    await CustomerLinkModel.deleteOne({ user: id }).exec();
    if (user.avatar) await cloudinaryStorage.remove(user.avatar);
  }
}

export const userService = new UserService();
