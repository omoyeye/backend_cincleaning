import * as Brevo from '@getbrevo/brevo';
import { getBrevoConfig } from './brevoConfig';
import { db } from '../db';
import { EMAIL_SHELL_MARKER, wrapHtmlInEmailShell } from '../messageTemplates/engine';

/**
 * Every email carries the branded layout (logo, contact details, footer). Templates are already wrapped;
 * hand-written HTML (GDPR notices, admin alerts, tests) is wrapped here. Full HTML documents are left alone.
 */
async function withBrandedLayout(html: string): Promise<string> {
    if (!html || html.includes(EMAIL_SHELL_MARKER) || /<html[\s>]/i.test(html)) return html;
    try {
        return await wrapHtmlInEmailShell(db, html, {});
    } catch (e) {
        console.error('[email] could not apply branded layout:', e instanceof Error ? e.message : e);
        return html;
    }
}

interface SendEmailParams {
    to: { email: string; name?: string }[];
    subject: string;
    htmlContent: string;
}

function buildApiInstance(apiKey: string): Brevo.TransactionalEmailsApi {
    const api = new Brevo.TransactionalEmailsApi();
    (api as any).authentications['apiKey'].apiKey = apiKey;
    return api;
}

export const sendEmail = async ({ to, subject, htmlContent }: SendEmailParams) => {
    const cfg = getBrevoConfig();
    if (!cfg.apiKey) {
        console.warn('BREVO_API_KEY not set. Email not sent:', subject);
        return;
    }

    const api = buildApiInstance(cfg.apiKey);
    const sendSmtpEmail = new Brevo.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = await withBrandedLayout(htmlContent);
    const senderName = cfg.senderName?.trim() || 'CiN Cleaning';
    const senderEmail = cfg.senderEmail?.trim() || 'no-reply@niceandneat.com';
    sendSmtpEmail.sender = { name: senderName, email: senderEmail };
    sendSmtpEmail.to = to;

    try {
        const data = await api.sendTransacEmail(sendSmtpEmail);
        const messageId = (data as any)?.body?.messageId ?? (data as any)?.messageId ?? '';
        console.log(`Email sent: "${subject}"${messageId ? ` (${messageId})` : ''}`);
        return data;
    } catch (error: any) {
        // Never log the raw client error: it carries the request headers, including the Brevo api-key.
        const status = error?.response?.status ?? error?.statusCode ?? '';
        const detail = error?.response?.data?.message ?? error?.body?.message ?? error?.message ?? 'unknown error';
        console.error(`Error sending email "${subject}": ${status} ${detail}`.trim());
        throw new Error(`Email send failed${status ? ` (${status})` : ''}: ${detail}`);
    }
};

export const sendBulkEmail = async (recipients: { email: string; name?: string }[], subject: string, htmlContent: string) => {
    return sendEmail({ to: recipients, subject, htmlContent });
};
