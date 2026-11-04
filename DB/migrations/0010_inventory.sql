CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`reorder_level` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_name_unit_idx` ON `items` (`name`,`unit`);--> statement-breakpoint
CREATE TABLE `purchase_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`po_id` text NOT NULL,
	`item_id` text NOT NULL,
	`qty` integer NOT NULL,
	`expected_price` integer,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`note` text,
	`requested_at` text NOT NULL,
	`requested_by` text,
	`approved_at` text,
	`approved_by` text,
	`cancelled_at` text,
	`cancelled_by` text,
	`cancel_reason` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `purchase_orders_status_idx` ON `purchase_orders` (`status`);--> statement-breakpoint
CREATE TABLE `stock_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text DEFAULT 'purchase' NOT NULL,
	`vendor_id` text,
	`po_line_id` text,
	`qty` integer NOT NULL,
	`unit_price` integer,
	`purchase_date` text NOT NULL,
	`created_at` text NOT NULL,
	`received_by` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_line_id`) REFERENCES `purchase_order_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_ins_item_idx` ON `stock_ins` (`item_id`,`purchase_date`);--> statement-breakpoint
CREATE TABLE `stock_outs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`qty` integer NOT NULL,
	`date` text NOT NULL,
	`taken_by_staff_id` text,
	`note` text,
	`created_at` text NOT NULL,
	`recorded_by` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`taken_by_staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_outs_item_idx` ON `stock_outs` (`item_id`,`date`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`contact` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_name_unique` ON `vendors` (`name`);--> statement-breakpoint
INSERT INTO `items` (`id`, `name`, `unit`, `reorder_level`, `sort_order`, `created_at`) VALUES
  ('massage-oil',     'Massage oil',                 'gal',          1, 10,  '2026-11-04T00:00:00.000Z'),
  ('massage-lotion',  'Massage lotion',              'gal',          1, 20,  '2026-11-04T00:00:00.000Z'),
  ('foot-soak',       'Foot soak',                   'gal',          1, 30,  '2026-11-04T00:00:00.000Z'),
  ('alcohol',         'Alcohol',                     'gal',          1, 40,  '2026-11-04T00:00:00.000Z'),
  ('tea-lights-50',   'Tea lights',                  'pack of 50',   1, 50,  '2026-11-04T00:00:00.000Z'),
  ('tea-lights-100',  'Tea lights',                  'pack of 100',  1, 51,  '2026-11-04T00:00:00.000Z'),
  ('peppermint-oil',  'Peppermint oil for diffuser', 'liter',        1, 60,  '2026-11-04T00:00:00.000Z'),
  ('ginger-tea',      'Ginger tea',                  '500 g',        1, 70,  '2026-11-04T00:00:00.000Z'),
  ('bleach',          'Chlorine bleach',             'gal',          1, 80,  '2026-11-04T00:00:00.000Z'),
  ('dish-soap',       'Dishwashing soap',            'gal',          1, 90,  '2026-11-04T00:00:00.000Z'),
  ('hand-soap',       'Liquid hand soap',            'gal',          1, 100, '2026-11-04T00:00:00.000Z'),
  ('epsom-1kg',       'Epsom salt',                  '1 kg',         1, 110, '2026-11-04T00:00:00.000Z'),
  ('epsom-1.5kg',     'Epsom salt',                  '1.5 kg',       1, 111, '2026-11-04T00:00:00.000Z'),
  ('trash-bags-s',    'Trash bags, small',           'pack',         1, 120, '2026-11-04T00:00:00.000Z'),
  ('trash-bags-m',    'Trash bags, medium',          'pack',         1, 121, '2026-11-04T00:00:00.000Z'),
  ('tissue',          'Tissue',                      'roll',         6, 130, '2026-11-04T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0010_inventory' WHERE `key` = 'schema_version';
