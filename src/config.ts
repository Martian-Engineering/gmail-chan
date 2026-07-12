import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  buildSecretInputSchema,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const OAuthConfigSchema = z
  .object({
    clientId: buildSecretInputSchema().optional(),
    clientSecret: buildSecretInputSchema().optional(),
    refreshToken: buildSecretInputSchema().optional(),
  })
  .strict()
  .default({});

export const GmailAccountConfigSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().default(true),
    email: z.string().trim().toLowerCase().email(),
    oauth: OAuthConfigSchema,
    allowFrom: z.array(z.string().trim().min(1)).default([]),
    allowTo: z.array(z.string().trim().min(1)).default([]),
    pollIntervalSeconds: z.number().int().min(10).max(3_600).default(30),
  })
  .strict();

export const GmailChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultAccount: z.string().trim().min(1).optional(),
    accounts: z
      .record(z.string().trim().min(1), GmailAccountConfigSchema)
      .default({}),
  })
  .strict();

export type GmailOAuthConfig = {
  clientId?: SecretInput;
  clientSecret?: SecretInput;
  refreshToken?: SecretInput;
};

export type GmailAccountConfig = z.infer<typeof GmailAccountConfigSchema>;
export type GmailChannelConfig = z.infer<typeof GmailChannelConfigSchema>;
export type GmailChannelConfigInput = z.input<typeof GmailChannelConfigSchema>;

type ChannelConfigSchema = NonNullable<ChannelPlugin["configSchema"]>;

/** Channel schema with the JSON and runtime validators expected by OpenClaw. */
export const gmailConfigSchema: ChannelConfigSchema = {
  schema: z.toJSONSchema(GmailChannelConfigSchema),
  runtime: {
    safeParse(value: unknown) {
      const result = GmailChannelConfigSchema.safeParse(value);
      return result.success
        ? { success: true, data: result.data }
        : {
            success: false,
            issues: result.error.issues.map((issue) => ({
              path: issue.path.filter(
                (part): part is string | number =>
                  typeof part === "string" || typeof part === "number",
              ),
              message: issue.message,
              code: issue.code,
            })),
          };
    },
  },
};
