import { Resend } from "resend";
import { requireEnv } from "./env";

let resendInstance: Resend | null = null;

/**
 * Lazily creates the Resend client using RESEND_API_KEY from env.
 */
export function getResendClient(): Resend {
  if (!resendInstance) {
    resendInstance = new Resend(requireEnv("RESEND_API_KEY"));
  }
  return resendInstance;
}

export function getResendFromEmail(): string {
  return requireEnv("RESEND_FROM_EMAIL");
}
