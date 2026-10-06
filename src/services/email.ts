import * as Brevo from '@getbrevo/brevo';
import { getBrevoConfig } from './brevoConfig';

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
    sendSmtpEmail.htmlContent = htmlContent;
    const senderName = cfg.senderName?.trim() || 'CiN Cleaning';
    const senderEmail = cfg.senderEmail?.trim() || 'no-reply@niceandneat.com';
    sendSmtpEmail.sender = { name: senderName, email: senderEmail };
    sendSmtpEmail.to = to;

    try {
        const data = await api.sendTransacEmail(sendSmtpEmail);
        console.log('Email sent successfully. Returned data: ' + JSON.stringify(data));
        return data;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};

export const sendBulkEmail = async (recipients: { email: string; name?: string }[], subject: string, htmlContent: string) => {
    return sendEmail({ to: recipients, subject, htmlContent });
};
