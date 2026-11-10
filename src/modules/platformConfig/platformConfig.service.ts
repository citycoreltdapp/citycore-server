import { logger } from '@/config/logger';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import {
  DEFAULT_WALLET_SETTINGS,
  MANAGED_CONFIGS,
  MANAGED_CONFIG_CATEGORY,
  MANAGED_CONFIG_NAMES,
  MANAGED_CONFIG_ORDER,
  REFERRAL_CONFIG_CATEGORY,
  managedConfigName,
  type WalletSettingName,
  type WalletSettings,
} from './platformConfig.managed';
import { PlatformConfigModel, type IPlatformConfig } from './platformConfig.model';
import { configValueError } from './platformConfig.schemas';

type ConfigInput = Partial<
  Omit<IPlatformConfig, 'key' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt'>
>;

const DUPLICATE_KEY_ERROR = 11000;

const managedLocked = (message: string) => AppError.forbidden(message, 'CONFIG_LOCKED');

const invalidValue = (message: string) => AppError.validation([{ path: 'body.value', message }]);

class PlatformConfigService extends BaseService<IPlatformConfig> {
  constructor() {
    super(PlatformConfigModel, {
      resourceName: 'Platform config',
      searchFields: ['key', 'label', 'description'],
    });
  }

  async getByKey(key: string) {
    const config = await this.findOne({ key });
    if (!config) throw this.notFound();
    return config;
  }

  createConfig(data: ConfigInput & { key: string }, actorId: string) {
    if (managedConfigName(data.key)) {
      throw managedLocked('This key is reserved for a setting the system manages');
    }
    return this.create({ ...data, createdBy: actorId as never, updatedBy: actorId as never });
  }

  /** Checks the value and type as they would end up, since a request may change only one. */
  async updateConfig(key: string, data: ConfigInput, actorId: string) {
    const config = await this.getByKey(key);

    const managedName = managedConfigName(key);
    if (managedName) await this.assertManagedUpdate(managedName, data);

    const message = configValueError(
      data.type ?? config.type,
      data.value === undefined ? config.value : data.value,
    );
    if (message) throw invalidValue(message);

    config.set({ ...data, updatedBy: actorId });
    await config.save();
    return config;
  }

  private async assertManagedUpdate(name: WalletSettingName, data: ConfigInput): Promise<void> {
    if (Object.keys(data).some((field) => field !== 'value')) {
      throw managedLocked('Only the value of this setting can be changed');
    }

    const result = MANAGED_CONFIGS[name].rule.safeParse(data.value);
    if (!result.success) {
      throw invalidValue(result.error.issues[0]?.message ?? 'Invalid value');
    }

    const next = { ...(await this.walletSettings()), [name]: result.data };
    const broken = MANAGED_CONFIG_ORDER.find(({ lower, upper }) => next[lower] > next[upper]);
    if (broken) throw invalidValue(broken.message);
  }

  async removeConfig(key: string): Promise<void> {
    if (managedConfigName(key)) throw managedLocked('This setting cannot be deleted');
    const config = await this.getByKey(key);
    await config.deleteOne();
  }

  /** Every public setting, as `{ key: value }`. */
  async publicValues(): Promise<Record<string, unknown>> {
    const configs = await PlatformConfigModel.find({ isPublic: true })
      .select('key value')
      .sort('key')
      .lean()
      .exec();
    return Object.fromEntries(configs.map(({ key, value }) => [key, value]));
  }

  /**
   * The wallet's limits and fees right now. Read from the database each time, not cached, so a
   * change applies at once on every server. A stored value that fails its rule isn't trusted.
   */
  async walletSettings(): Promise<WalletSettings> {
    const keys = MANAGED_CONFIG_NAMES.map((name) => MANAGED_CONFIGS[name].key);
    const stored = await PlatformConfigModel.find({ key: { $in: keys } })
      .select('key value')
      .lean()
      .exec();

    const settings = { ...DEFAULT_WALLET_SETTINGS };
    for (const { key, value } of stored) {
      const name = managedConfigName(key) as WalletSettingName;
      const result = MANAGED_CONFIGS[name].rule.safeParse(value);
      if (result.success) settings[name] = result.data;
      else logger.error({ key }, 'Invalid stored wallet setting, so using the .env value');
    }
    return settings;
  }

  /** Creates any managed setting that doesn't exist yet, and leaves the others as they are. */
  async seedManagedConfigs(): Promise<void> {
    const keys = MANAGED_CONFIG_NAMES.map((name) => MANAGED_CONFIGS[name].key);
    const existing = await PlatformConfigModel.distinct('key', { key: { $in: keys } }).exec();
    const missing = MANAGED_CONFIG_NAMES.map((name) => MANAGED_CONFIGS[name]).filter(
      ({ key }) => !existing.includes(key),
    );
    if (missing.length === 0) return;

    try {
      await PlatformConfigModel.insertMany(
        missing.map(({ key, label, description, fallback }) => ({
          key,
          label,
          description,
          category: key.startsWith(`${REFERRAL_CONFIG_CATEGORY}.`)
            ? REFERRAL_CONFIG_CATEGORY
            : MANAGED_CONFIG_CATEGORY,
          type: 'number',
          value: fallback,
        })),
        { ordered: false },
      );
    } catch (err) {
      // Another server starting at the same moment created them first.
      if ((err as { code?: number }).code !== DUPLICATE_KEY_ERROR) throw err;
    }
  }
}

export const platformConfigService = new PlatformConfigService();
