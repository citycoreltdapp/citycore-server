export const signupBody = <T extends { password: string }>(body: T) => ({
  accountType: 'personal',
  confirmPassword: body.password,
  terms: true,
  ...body,
});
