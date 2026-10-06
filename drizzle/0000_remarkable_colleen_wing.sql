CREATE TABLE `blog_posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`slug` varchar(200) NOT NULL,
	`excerpt` text,
	`body_html` text NOT NULL,
	`hero_image_url` longtext,
	`meta_title` varchar(255),
	`meta_description` text,
	`meta_keywords` text,
	`published` boolean NOT NULL DEFAULT true,
	`published_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `blog_posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `blog_posts_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `booking_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int,
	`sender_id` int,
	`sender_role` varchar(20) NOT NULL,
	`sender_name` varchar(255) NOT NULL,
	`text` text NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `booking_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `booking_reminder_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int,
	`window_label` varchar(16) NOT NULL,
	`channels` varchar(160) NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `booking_reminder_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `booking_staff` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int,
	`staff_id` int,
	`is_primary` boolean DEFAULT false,
	CONSTRAINT `booking_staff_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` varchar(20),
	`customer_id` int,
	`service_type` varchar(50) NOT NULL,
	`date` varchar(20) NOT NULL,
	`time` varchar(10) NOT NULL,
	`status` varchar(20) DEFAULT 'Pending',
	`total_price` decimal(10,2) NOT NULL,
	`address_line_1` varchar(255) NOT NULL,
	`address_city` varchar(100) NOT NULL,
	`address_postcode` varchar(20) NOT NULL,
	`contact_name` varchar(255) NOT NULL,
	`contact_email` varchar(255) NOT NULL,
	`contact_phone` varchar(50),
	`property_details` json,
	`extras` json,
	`instructions` text,
	`assigned_staff_id` int,
	`work_completion` json,
	`discount_code` varchar(50),
	`discount_amount` decimal(10,2) DEFAULT '0',
	`points_earned` int DEFAULT 0,
	`rating` int,
	`feedback` text,
	`chat_history` json,
	`chat_closed_by_admin` boolean DEFAULT false,
	`chat_closed_at` timestamp,
	`invoice_paid` boolean NOT NULL DEFAULT false,
	`admin_notes` text,
	`stripe_payment_link` text,
	`reminder_48h_sent_at` timestamp,
	`reminder_24h_sent_at` timestamp,
	`deposit_terms_accepted_at` timestamp,
	`short_notice_cancel_fee_consented_at` timestamp,
	`payment_fee_evidence` json,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `bookings_booking_id_unique` UNIQUE(`booking_id`)
);
--> statement-breakpoint
CREATE TABLE `business_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`key` varchar(100) NOT NULL,
	`value` longtext,
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `business_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `business_settings_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `discounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`type` varchar(20) DEFAULT 'fixed',
	`value` decimal(10,2) NOT NULL,
	`min_order_value` decimal(10,2) DEFAULT '0',
	`expires_at` timestamp,
	`is_active` boolean DEFAULT true,
	`usage_limit` int,
	`used_count` int DEFAULT 0,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `discounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `discounts_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`body` text NOT NULL,
	`description` text,
	`variables` json,
	`active` boolean DEFAULT true,
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `email_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_templates_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `extra_services` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`price` decimal(10,2) NOT NULL,
	`type` varchar(50) DEFAULT 'fixed',
	`duration` int DEFAULT 30,
	`active` boolean DEFAULT true,
	CONSTRAINT `extra_services_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gallery_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`image_url` text NOT NULL,
	`caption` text,
	`sort_order` int NOT NULL DEFAULT 0,
	`published` boolean NOT NULL DEFAULT true,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `gallery_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int,
	`type` varchar(50) NOT NULL,
	`message` text NOT NULL,
	`is_read` boolean DEFAULT false,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`base_rate` decimal(10,2) NOT NULL,
	`pricing_model` varchar(50) DEFAULT 'hourly',
	`min_duration` int DEFAULT 2,
	`min_notice` int DEFAULT 2,
	`call_out_charge` decimal(10,2),
	`description` text,
	`features` json,
	`icon` varchar(50),
	`active` boolean DEFAULT true,
	`booking_flow` json,
	CONSTRAINT `services_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sms_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`message` text NOT NULL,
	`description` text,
	`variables` json,
	`active` boolean DEFAULT true,
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `sms_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `sms_templates_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`role` varchar(50) DEFAULT 'Cleaner',
	`hourly_rate` decimal(10,2),
	`skills` json,
	`availability` json,
	`status` varchar(20) DEFAULT 'Active',
	`phone` varchar(50),
	`address` text,
	`postcode` varchar(20),
	`image_url` text,
	`bank_name` varchar(100),
	`account_number` varchar(50),
	`sort_code` varchar(20),
	CONSTRAINT `staff_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `staff_cancel_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int,
	`staff_user_id` int,
	`staff_name` varchar(255),
	`reason` text,
	`admin_notes` text,
	`responded_by` int,
	`responded_at` timestamp,
	`status` varchar(20) NOT NULL DEFAULT 'Pending',
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `staff_cancel_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `staff_invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`staff_id` int,
	`staff_name` varchar(255),
	`week_label` varchar(20) NOT NULL,
	`week_start` varchar(20),
	`week_end` varchar(20),
	`total_amount` decimal(10,2) NOT NULL,
	`week_total_hours` decimal(10,2) DEFAULT '0',
	`week_job_count` int DEFAULT 0,
	`jobs_json` json NOT NULL,
	`bank_json` json,
	`status` varchar(20) NOT NULL DEFAULT 'Pending',
	`admin_notes` text,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `staff_invoices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `superadmins` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`reset_token` varchar(255),
	`reset_token_expiry` timestamp,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `superadmins_id` PRIMARY KEY(`id`),
	CONSTRAINT `superadmins_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`role` varchar(50) NOT NULL DEFAULT 'customer',
	`is_verified` boolean DEFAULT false,
	`loyalty_points` int DEFAULT 0,
	`referral_code` varchar(20),
	`referred_by` varchar(20),
	`phone` varchar(50),
	`address` text,
	`postcode` varchar(20),
	`admin_tabs` json,
	`reset_token` varchar(255),
	`reset_token_expiry` timestamp,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `users_referral_code_unique` UNIQUE(`referral_code`)
);
--> statement-breakpoint
ALTER TABLE `booking_messages` ADD CONSTRAINT `booking_messages_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_messages` ADD CONSTRAINT `booking_messages_sender_id_users_id_fk` FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_reminder_log` ADD CONSTRAINT `booking_reminder_log_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_staff` ADD CONSTRAINT `booking_staff_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_staff` ADD CONSTRAINT `booking_staff_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_customer_id_users_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_assigned_staff_id_staff_id_fk` FOREIGN KEY (`assigned_staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff` ADD CONSTRAINT `staff_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_cancel_requests` ADD CONSTRAINT `staff_cancel_requests_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_cancel_requests` ADD CONSTRAINT `staff_cancel_requests_staff_user_id_users_id_fk` FOREIGN KEY (`staff_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_cancel_requests` ADD CONSTRAINT `staff_cancel_requests_responded_by_users_id_fk` FOREIGN KEY (`responded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_invoices` ADD CONSTRAINT `staff_invoices_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;