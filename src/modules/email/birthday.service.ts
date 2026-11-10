import { logger } from '@/config/logger';
import { UserModel } from '@/modules/user/user.model';
import {
  BIRTHDAY_SETTINGS_ID,
  BirthdaySettingsModel,
  EmailLogModel,
  type IBirthdaySettings,
} from './email.model';
import { emailService } from './email.service';
import { emailTemplates } from './email.templates';

interface MonthDay {
  month: number;
  day: number;
}

interface BirthdayUser {
  _id: unknown;
  name: string;
  email: string;
  avatar?: string | null;
  dateOfBirth: Date | null;
  preferences?: { emailNotifications?: boolean };
}

export interface SendBirthdayInput {
  /** Who to send to. Everyone whose birthday is today, when empty. */
  userIds?: string[];
  subject?: string;
  message?: string;
}

const USER_FIELDS = 'name email avatar dateOfBirth preferences';
const SAMPLE_NAME = 'Ada Obi';
const pad = (value: number) => String(value).padStart(2, '0');

/** The calendar date and hour right now in a timezone. */
const localNow = (now: Date, timezone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, Number(value)]),
  ) as { year: number; month: number; day: number; hour: number };
  return parts;
};

const isLeapYear = (year: number) => new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;

/** Whose birthdays fall on a date. Those born on 29 February celebrate on the 28th in other years. */
const birthdaysOn = (year: number, month: number, day: number): MonthDay[] =>
  month === 2 && day === 28 && !isLeapYear(year)
    ? [
        { month: 2, day: 28 },
        { month: 2, day: 29 },
      ]
    : [{ month, day }];

const matchBirthdays = (dates: MonthDay[]) => ({
  isActive: true,
  dateOfBirth: { $ne: null },
  $expr: {
    $or: dates.map(({ month, day }) => ({
      $and: [
        { $eq: [{ $month: '$dateOfBirth' }, month] },
        { $eq: [{ $dayOfMonth: '$dateOfBirth' }, day] },
      ],
    })),
  },
});

const dedupeKey = (userId: unknown, year: number) => `birthday:${String(userId)}:${year}`;

const optedOut = (user: BirthdayUser) => user.preferences?.emailNotifications === false;

export const birthdayService = {
  async getSettings() {
    return BirthdaySettingsModel.findOneAndUpdate(
      { _id: BIRTHDAY_SETTINGS_ID },
      {},
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    )
      .orFail()
      .exec();
  },

  async updateSettings(data: Partial<IBirthdaySettings>, actorId: string) {
    const settings = await this.getSettings();
    settings.set({ ...data, updatedBy: actorId });
    await settings.save();
    return settings;
  },

  /** Shows an email as the customer would get it, without sending anything. */
  async preview({ subject, message }: { subject?: string; message?: string }) {
    const settings = await this.getSettings();
    const email = emailTemplates.birthday({
      name: SAMPLE_NAME,
      subject: subject ?? settings.subject,
      message: message ?? settings.message,
    });
    return { subject: email.subject, html: email.html, text: email.text };
  },

  /** Birthdays in the next `days` days, soonest first, with whether this year's email has gone. */
  async upcoming(days: number, now = new Date()) {
    const { timezone } = await this.getSettings();
    const today = localNow(now, timezone);

    const occurrences = new Map<string, { daysUntil: number; date: string; year: number }>();
    const dates: MonthDay[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      for (const birthday of birthdaysOn(year, month, day)) {
        dates.push(birthday);
        occurrences.set(`${birthday.month}-${birthday.day}`, {
          daysUntil: offset,
          date: `${year}-${pad(month)}-${pad(day)}`,
          year,
        });
      }
    }

    const users = (await UserModel.find(matchBirthdays(dates))
      .select(USER_FIELDS)
      .lean()
      .exec()) as unknown as BirthdayUser[];

    const rows = users.map((user) => {
      const born = user.dateOfBirth as Date;
      const month = born.getUTCMonth() + 1;
      const day = born.getUTCDate();
      const occurrence = occurrences.get(`${month}-${day}`) as {
        daysUntil: number;
        date: string;
        year: number;
      };
      return { user, month, day, ...occurrence };
    });

    const logs = await EmailLogModel.find({
      dedupeKey: { $in: rows.map(({ user, year }) => dedupeKey(user._id, year)) },
    })
      .select('dedupeKey status sentAt')
      .lean()
      .exec();
    const logByKey = new Map(logs.map((log) => [log.dedupeKey, log]));

    return rows
      .map(({ user, month, day, daysUntil, date, year }) => {
        const log = logByKey.get(dedupeKey(user._id, year));
        return {
          id: String(user._id),
          name: user.name,
          email: user.email,
          avatar: user.avatar ?? null,
          // Staff need the day, not how old anyone is.
          birthday: `${pad(month)}-${pad(day)}`,
          nextOccurrence: date,
          daysUntil,
          emailOptedOut: optedOut(user),
          emailStatus: log?.status ?? null,
          sentAt: log?.sentAt ?? null,
        };
      })
      .sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name));
  },

  /**
   * Queues this year's email for each person, unless they already have one, however it was sent.
   * The unique key is what guarantees that when servers or staff overlap.
   */
  async send(
    { userIds, subject, message }: SendBirthdayInput,
    actorId: string | null,
    now = new Date(),
  ) {
    const settings = await this.getSettings();
    const today = localNow(now, settings.timezone);

    const users = (await (
      userIds?.length
        ? UserModel.find({ _id: { $in: userIds }, isActive: true })
        : UserModel.find(matchBirthdays(birthdaysOn(today.year, today.month, today.day)))
    )
      .select(USER_FIELDS)
      .lean()
      .exec()) as unknown as BirthdayUser[];

    const result = {
      queued: 0,
      alreadySent: 0,
      optedOut: 0,
      noDateOfBirth: 0,
      notFound: userIds?.length ? new Set(userIds).size - users.length : 0,
    };

    for (const user of users) {
      if (!user.dateOfBirth) result.noDateOfBirth += 1;
      else if (optedOut(user)) result.optedOut += 1;
      else {
        const queued = await emailService.queue({
          to: user.email,
          user: String(user._id),
          triggeredBy: actorId,
          dedupeKey: dedupeKey(user._id, today.year),
          email: emailTemplates.birthday({
            name: user.name,
            subject: subject ?? settings.subject,
            message: message ?? settings.message,
          }),
        });
        if (queued) result.queued += 1;
        else result.alreadySent += 1;
      }
    }
    return result;
  },

  /** Runs on a timer through the day, so a server that was down at the set hour still catches up. */
  async runScheduled(now = new Date()) {
    const settings = await this.getSettings();
    if (!settings.autoSendEnabled) return null;
    if (localNow(now, settings.timezone).hour < settings.sendHour) return null;

    const result = await this.send({}, null, now);
    if (result.queued > 0) logger.info(result, 'Birthday emails queued');
    return result;
  },
};
