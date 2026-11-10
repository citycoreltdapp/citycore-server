import { z } from 'zod';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { logger } from '@/config/logger';
import { emailSchema, nameSchema, passwordSchema } from '@/core/validation/common.schemas';
import { userService } from '@/modules/user/user.service';

const adminEnvSchema = z.object({
  ADMIN_NAME: nameSchema.default('Administrator'),
  ADMIN_EMAIL: emailSchema,
  ADMIN_PASSWORD: passwordSchema,
});

const seedAdmin = async (): Promise<void> => {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = adminEnvSchema.parse(process.env);

  await connectDatabase();

  const result = await userService.ensureSuperAdmin({
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  logger.info({ result }, 'Super admin seed finished');
};

seedAdmin()
  .catch((err: unknown) => {
    logger.error({ err }, 'Failed to seed admin');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
