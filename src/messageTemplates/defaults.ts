/** Seed rows for `email_templates` - `name` is the stable key used in code. */

export type EmailTemplateSeed = {
  name: string;
  subject: string;
  body: string;
  description: string;
  variables: string[];
};

export type SmsTemplateSeed = {
  name: string;
  message: string;
  description: string;
  variables: string[];
};

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateSeed[] = [
  {
    name: 'email_shell',
    subject: '-',
    description:
      'Outer layout for all transactional emails. Edit colors, header, and footer. Keep {{inner_content}} where the specific email body should appear. {{brand_logo_block}} and {{contact_block}} are filled from business settings + SITE_URL.',
    variables: ['inner_content', 'brand_name', 'brand_primary', 'footer_note', 'brand_logo_block', 'contact_block'],
    body: `<div style="background:#f1f5f9;padding:28px 16px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,0.08);">
    {{brand_logo_block}}
    <div style="background:{{brand_primary}};color:#ffffff;padding:22px 24px;font-size:20px;font-weight:800;letter-spacing:-0.02em;">{{brand_name}}</div>
    <div style="padding:28px 24px;line-height:1.65;font-size:15px;">{{inner_content}}</div>
    {{contact_block}}
    <div style="padding:18px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.5;">
      {{footer_note}}
      <p style="margin:12px 0 0;font-size:11px;color:#94a3b8;">
        You are receiving this email because you have an account with {{brand_name}} or made a booking with us.
        To manage your email preferences or exercise your data rights under UK GDPR, please log in to your account or contact us.
        {{brand_name}} is a trading name of Surpluslink &amp; Co LTD, registered in England &amp; Wales.
      </p>
    </div>
  </div>
</div>`,
  },
  {
    name: 'customer_welcome',
    subject: 'Welcome to {{brand_name}} - your account is ready',
    description: 'Sent when a new customer registers. Includes referral code and QR.',
    variables: ['client_name', 'client_email', 'referral_code', 'qr_code_url', 'brand_name', 'brand_primary', 'footer_note'],
    body: `<p>Hi {{client_name}},</p>
<p>We're glad you're here. Your client account is set up so you can book, track cleans, and earn rewards.</p>
<div style="background:#f8fafc;border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid #e2e8f0;">
  <p style="margin:0 0 8px;font-weight:700;color:#0f172a;">Your details</p>
  <p style="margin:4px 0;"><strong>Email:</strong> {{client_email}}</p>
  <p style="margin:4px 0;"><strong>Referral code:</strong> <span style="font-family:monospace;font-size:1.05em;">{{referral_code}}</span></p>
</div>
<div style="text-align:center;margin:24px 0;">
  <p style="margin-bottom:12px;font-weight:600;">Share your code with a QR</p>
  <img src="{{qr_code_url}}" alt="Referral QR" style="max-width:180px;border:1px solid #e2e8f0;border-radius:12px;padding:8px;background:#fff;" />
</div>
<p><strong>What's next</strong></p>
<ul style="padding-left:20px;margin:8px 0;">
  <li>Book online in a few taps</li>
  <li>Earn loyalty points when jobs complete</li>
  <li>Priority support when you need us</li>
</ul>
<p style="color:#64748b;font-size:14px;">Keep this email for your records.</p>`,
  },
  {
    name: 'staff_welcome_credentials',
    subject: 'Your {{brand_name}} portal login',
    description: 'Sent when an admin creates a staff or admin user with a generated password.',
    variables: [
      'staff_name',
      'staff_email',
      'role',
      'temporary_password',
      'staff_portal_link',
      'referral_code',
      'referral_link',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<p>Hi {{staff_name}},</p>
<p>An administrator has created your <strong>{{role}}</strong> account for the team portal.</p>
<div style="background:#f8fafc;border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid #e2e8f0;">
  <p style="margin:0 0 8px;font-weight:700;">Sign-in details</p>
  <p style="margin:4px 0;"><strong>Email:</strong> {{staff_email}}</p>
  <p style="margin:4px 0;"><strong>Role:</strong> {{role}}</p>
  <p style="margin:4px 0;"><strong>Temporary password:</strong> <span style="font-family:monospace;font-size:1.05em;">{{temporary_password}}</span></p>
</div>
<p style="margin:0 0 14px;">
  <a href="{{staff_portal_link}}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:700;">
    Open Staff Portal
  </a>
</p>
<p style="margin:4px 0;color:#64748b;font-size:13px;">Direct link: <a href="{{staff_portal_link}}" style="color:#0f766e;">{{staff_portal_link}}</a></p>
<div style="background:#ecfeff;border:1px solid #bae6fd;border-radius:12px;padding:14px 16px;margin:16px 0;">
  <p style="margin:0 0 6px;font-weight:700;color:#0f172a;">Your referral details</p>
  <p style="margin:4px 0;"><strong>Code:</strong> <span style="font-family:monospace;font-size:1.05em;">{{referral_code}}</span></p>
  <p style="margin:4px 0;color:#475569;font-size:13px;">Share link: <a href="{{referral_link}}" style="color:#0369a1;">{{referral_link}}</a></p>
</div>
<p>Please log in as soon as you can and change your password from your profile.</p>`,
  },
  {
    name: 'client_booking_reminder',
    subject: 'Reminder: booking {{booking_id}} on {{service_date}}',
    description: 'Sent when staff or admin triggers a booking reminder (in-app notification + email if address on file).',
    variables: [
      'client_name',
      'booking_id',
      'service_type',
      'service_date',
      'service_time',
      'custom_message',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<p>Hi {{client_name}},</p>
<p>{{custom_message}}</p>
<p style="margin-top:16px;padding:14px 16px;background:#f0fdfa;border-radius:10px;border:1px solid #99f6e4;">
  <strong>{{service_type}}</strong><br />
  <span style="color:#0f766e;">{{service_date}}</span> at <strong>{{service_time}}</strong><br />
  <span style="font-size:13px;color:#475569;">Reference: {{booking_id}}</span>
</p>
<p>We look forward to seeing you.</p>`,
  },
  {
    name: 'client_booking_confirmation',
    subject: 'Booking confirmed - {{booking_id}}',
    description:
      'Sent when a new booking is created (if contact email is present). Includes full submitted details in {{booking_details_html}}.',
    variables: [
      'client_name',
      'booking_id',
      'booking_details_html',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<p>Hi {{client_name}},</p>
<p>Thanks for booking with <strong>{{brand_name}}</strong>. Below is a <strong>full summary</strong> of the details you submitted - please check everything is correct.</p>
{{booking_details_html}}
<p style="font-size:14px;color:#64748b;margin-top:20px;">Need to change something? Reply to this email or contact us from your client portal.</p>`,
  },
  {
    name: 'admin_new_booking_alert',
    subject: 'New booking - {{booking_id}} - {{service_date}} @ {{service_time}}',
    description:
      'Sent to the business inbox when a customer submits a booking. Same detail block as the customer confirmation.',
    variables: [
      'booking_id',
      'service_date',
      'service_time',
      'booking_details_html',
      'client_email',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<h2 style="margin:0 0 12px;color:#0f172a;font-size:18px;">New booking received</h2>
<p style="margin:0 0 16px;color:#475569;font-size:15px;">A customer has submitted a booking. Full details are below. Customer email: <strong>{{client_email}}</strong></p>
{{booking_details_html}}
<p style="font-size:13px;color:#64748b;margin-top:20px;">Open the admin dashboard to confirm, assign staff, and manage this job.</p>`,
  },
  {
    name: 'client_booking_cancelled',
    subject: 'Booking cancelled - {{booking_id}}',
    description: 'Sent when the client cancels a booking from the portal (Brevo). Includes optional short-notice fee note.',
    variables: [
      'client_name',
      'booking_id',
      'service_type',
      'service_date',
      'service_time',
      'short_notice_line',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<p>Hi {{client_name}},</p>
<p>This email confirms that booking <strong>{{booking_id}}</strong> has been <strong>cancelled</strong> as requested.</p>
{{short_notice_line}}
<p style="margin-top:16px;padding:14px 16px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;">
  <strong>{{service_type}}</strong><br />
  <span style="color:#0f172a;">{{service_date}}</span> at <strong>{{service_time}}</strong>
</p>
<p style="font-size:14px;color:#64748b;">If you did not request this cancellation, contact us straight away using the details below.</p>`,
  },
  {
    name: 'admin_booking_cancelled_alert',
    subject: 'Client cancelled booking {{booking_id}} - {{service_date}} @ {{service_time}}',
    description: 'Sent to the business booking inbox when a client cancels from the portal.',
    variables: [
      'booking_id',
      'service_type',
      'service_date',
      'service_time',
      'client_name',
      'client_email',
      'booking_total',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<h2 style="margin:0 0 12px;color:#b91c1c;font-size:18px;">Booking cancelled by client</h2>
<p style="margin:0 0 16px;color:#475569;font-size:15px;">A customer has cancelled a booking from the client portal.</p>
<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px 18px;margin:16px 0;">
  <p style="margin:0 0 8px;"><strong>Reference</strong> {{booking_id}}</p>
  <p style="margin:4px 0;"><strong>Service</strong> {{service_type}}</p>
  <p style="margin:4px 0;"><strong>Scheduled</strong> {{service_date}} at {{service_time}}</p>
  <p style="margin:4px 0;"><strong>Client</strong> {{client_name}} &lt;{{client_email}}&gt;</p>
  <p style="margin:4px 0;"><strong>Booking total</strong> £{{booking_total}}</p>
</div>
<p style="font-size:13px;color:#64748b;">Review this job in the admin dashboard (pipeline / notifications).</p>`,
  },
  {
    name: 'client_job_completed_review',
    subject: 'How did we do? - {{booking_id}}',
    description:
      'Sent ~2 hours after a job is marked Completed. Asks the client to leave a Google review and rate in their portal.',
    variables: [
      'client_name',
      'booking_id',
      'service_type',
      'service_date',
      'google_review_url',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<p>Hi {{client_name}},</p>
<p>We hope your <strong>{{service_type}}</strong> on <strong>{{service_date}}</strong> was exactly what you needed.</p>
<p>Your feedback means a lot to our small team. If you have a moment, we'd really appreciate an honest review:</p>
<div style="text-align:center;margin:28px 0;">
  <a href="{{google_review_url}}" style="display:inline-block;background:{{brand_primary}};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:16px;letter-spacing:-0.01em;">
    Leave a Google Review
  </a>
</div>
<p style="text-align:center;font-size:13px;color:#64748b;">It only takes 30 seconds and helps other customers find us.</p>
<p>You can also rate your experience and leave feedback directly in your <strong>client portal</strong> under the booking details.</p>
<p>Thank you for choosing <strong>{{brand_name}}</strong>. We look forward to seeing you again!</p>`,
  },
  {
    name: 'client_quote_estimate',
    subject: 'Your {{service_type}} estimate from {{brand_name}}',
    description: 'Sent to a visitor immediately after they use the homepage instant-quote widget. Contains their estimate and a link to book for real.',
    variables: [
      'client_name',
      'service_type',
      'property_summary',
      'price_line',
      'discount_code',
      'booking_url',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<p>Hi {{client_name}},</p>
<p>Thanks for checking prices with {{brand_name}}. Here is the estimate you requested:</p>
<div style="margin:20px 0;padding:18px 20px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">
  <div style="font-size:13px;color:#64748b;">Service</div>
  <div style="font-weight:700;font-size:16px;">{{service_type}}</div>
  <div style="font-size:13px;color:#64748b;margin-top:10px;">Property</div>
  <div style="font-weight:600;">{{property_summary}}</div>
  <div style="font-size:13px;color:#64748b;margin-top:10px;">Estimated cost</div>
  <div style="font-weight:800;font-size:22px;color:{{brand_primary}};">{{price_line}}</div>
</div>
<p style="font-size:13px;color:#64748b;">This is an indicative estimate. Your final price is confirmed when you book and depends on the details you provide.</p>
<p>Ready to go ahead? Use code <strong>{{discount_code}}</strong> for 10% off your first clean.</p>
<div style="text-align:center;margin:28px 0;">
  <a href="{{booking_url}}" style="display:inline-block;background:{{brand_primary}};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:16px;">
    Book this clean
  </a>
</div>
<p>Questions? Just reply to this email and a member of the team will help.</p>`,
  },
  {
    name: 'client_rebooking_nudge',
    subject: 'Time for another clean? - {{brand_name}}',
    description: 'Sent ~3 weeks after a one-time completed booking if the client has not rebooked.',
    variables: [
        'client_name',
        'service_type',
        'last_booking_date',
        'booking_url',
        'brand_name',
        'brand_primary',
        'footer_note',
    ],
    body: `<p>Hi {{client_name}},</p>
<p>It's been a few weeks since your last <strong>{{service_type}}</strong> on <strong>{{last_booking_date}}</strong> and we wanted to check in.</p>
<p>Ready for a refresh? Booking takes less than a minute:</p>
<div style="text-align:center;margin:28px 0;">
  <a href="{{booking_url}}" style="display:inline-block;background:{{brand_primary}};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:16px;">
    Book Again
  </a>
</div>
<p>Regular cleans keep your space consistently fresh — and you earn <strong>loyalty points</strong> with every booking.</p>
<p>We'd love to see you again!</p>`,
  },
  {
    name: 'staff_weekly_invoice_admin',
    subject: 'Weekly pay request - {{staff_name}} ({{week}})',
    description: 'Sent to the business inbox when a staff member submits their weekly invoice.',
    variables: [
      'staff_name',
      'staff_id',
      'week',
      'total_amount',
      'hours_sum',
      'job_count',
      'bank_name',
      'account_number',
      'sort_code',
      'job_table_html',
      'brand_name',
      'brand_primary',
      'footer_note',
    ],
    body: `<h2 style="margin-top:0;color:#0f172a;">Weekly invoice submitted</h2>
<p><strong>Staff:</strong> {{staff_name}} (ID {{staff_id}})<br />
<strong>Week:</strong> {{week}}<br />
<strong>Total pay claimed:</strong> £{{total_amount}}<br />
<strong>Your hours (week):</strong> {{hours_sum}}<br />
<strong>Jobs:</strong> {{job_count}}</p>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
<h3 style="color:#0f172a;">Bank details</h3>
<p>Bank: {{bank_name}}<br />Account: {{account_number}}<br />Sort code: {{sort_code}}</p>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
<h3 style="color:#0f172a;">Job breakdown</h3>
<p style="font-size:13px;color:#475569;">Team jobs: pay = (booked hours ÷ staff on job) × hourly rate. Client job totals are for reference only.</p>
{{job_table_html}}`,
  },
];

export const DEFAULT_SMS_TEMPLATES: SmsTemplateSeed[] = [
  {
    name: 'staff_account_created',
    description: 'When admin creates a staff user (sent to staff mobile if on file).',
    variables: ['brand_name', 'staff_name', 'role', 'brand_phone', 'referral_code', 'referral_link'],
    message:
      '{{brand_name}}: Hi {{staff_name}}, your team portal account is ready ({{role}}). Referral code: {{referral_code}}. Link: {{referral_link}}. Check email for login details. Qs: {{brand_phone}}',
  },
  {
    name: 'staff_new_assignment',
    description: 'When a booking is assigned to a staff member.',
    variables: ['brand_name', 'staff_name', 'booking_id', 'client_name', 'service_date', 'service_time', 'job_address'],
    message:
      '{{brand_name}}: New job {{booking_id}} — {{client_name}} on {{service_date}} at {{service_time}}. {{job_address}}',
  },
  {
    name: 'customer_welcome_sms',
    description: 'Optional SMS after customer registers (requires mobile on signup).',
    variables: ['brand_name', 'client_name', 'brand_phone'],
    message:
      'Hi {{client_name}}, welcome to {{brand_name}}! Your account is ready — book anytime in your portal. Help: {{brand_phone}}',
  },
  {
    name: 'staff_sms_en_route',
    description: 'When staff taps “start travel” and the client has a mobile number.',
    variables: ['client_name', 'brand_name', 'staff_name'],
    message:
      'Hi {{client_name}}, your {{brand_name}} cleaner {{staff_name}} is on the way. You can track updates in your client portal.',
  },
  {
    name: 'staff_sms_clock_in',
    description: 'When staff clocks in on site.',
    variables: ['brand_name'],
    message: '{{brand_name}}: your cleaner has arrived and started your booking.',
  },
  {
    name: 'staff_sms_running_late',
    description: '“Running late” quick message from staff to the client.',
    variables: ['client_name', 'brand_name', 'staff_name'],
    message:
      'Hi {{client_name}}, {{staff_name}} from {{brand_name}} here - running slightly behind but still on the way for your clean today. Thanks for your patience!',
  },
  {
    name: 'staff_booking_reminder_sms',
    description: 'Automatic 48h / 24h reminders for assigned staff (server job). Requires staff mobile on file.',
    variables: [
      'brand_name',
      'staff_name',
      'booking_id',
      'service_type',
      'service_date',
      'service_time',
      'reminder_hint',
    ],
    message:
      '{{brand_name}}: Hi {{staff_name}}, {{reminder_hint}} — job {{booking_id}} ({{service_type}}) {{service_date}} {{service_time}}. Check your portal.',
  },
  {
    name: 'client_booking_reminder_sms',
    description: 'Automatic 48h / 24h booking reminders (server job). Requires client mobile on the booking.',
    variables: [
      'brand_name',
      'client_name',
      'booking_id',
      'service_type',
      'service_date',
      'service_time',
      'reminder_hint',
    ],
    message:
      '{{brand_name}}: Hi {{client_name}}, {{reminder_hint}} {{service_type}} ref {{booking_id}} on {{service_date}} at {{service_time}}.',
  },
  {
    name: 'client_job_completed_review_sms',
    description: 'Sent ~2 hours after job completion asking for a Google review.',
    variables: ['brand_name', 'client_name', 'google_review_url'],
    message:
      'Hi {{client_name}}, thanks for choosing {{brand_name}}! We\'d love your feedback — leave a quick Google review: {{google_review_url}}',
  },
];
