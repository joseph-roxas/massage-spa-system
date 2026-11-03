-- Starting catalogue and settings. Everything here is editable in the app;
-- price changes are added as new service_prices rows, never edited in place.

INSERT INTO `services` (`id`, `code`, `name`, `duration_min`, `kind`, `is_foot_type`, `voucher_eligible`, `sort_order`, `created_at`) VALUES
  ('foot-60',      'FM60', 'Foot Massage',          60, 'single', 1, 0, 10,  '2026-11-03T00:00:00.000Z'),
  ('foot-30',      'FM30', 'Foot Massage',          30, 'single', 1, 0, 11,  '2026-11-03T00:00:00.000Z'),
  ('back-60',      'BM60', 'Back Massage',          60, 'single', 0, 0, 20,  '2026-11-03T00:00:00.000Z'),
  ('back-30',      'BM30', 'Back Massage',          30, 'single', 1, 0, 21,  '2026-11-03T00:00:00.000Z'),
  ('thai-60',      'THAI', 'Thai Body Massage',     60, 'single', 0, 1, 30,  '2026-11-03T00:00:00.000Z'),
  ('swedish-60',   'SWE',  'Swedish Massage',       60, 'single', 0, 1, 40,  '2026-11-03T00:00:00.000Z'),
  ('aroma-90',     'ARO',  'Aromatherapy Massage',  90, 'single', 0, 1, 50,  '2026-11-03T00:00:00.000Z'),
  ('hotoil-90',    'HOIL', 'Hot Oil Massage',       90, 'single', 0, 0, 60,  '2026-11-03T00:00:00.000Z'),
  ('hotstone-90',  'HSTN', 'Hot Stone Massage',     90, 'single', 0, 0, 70,  '2026-11-03T00:00:00.000Z'),
  ('ventosa-90',   'VEN',  'Ventosa Massage',       90, 'single', 0, 1, 80,  '2026-11-03T00:00:00.000Z'),
  ('bodyscrub-60', 'BSC',  'Body Scrub',            60, 'single', 0, 0, 90,  '2026-11-03T00:00:00.000Z'),
  ('footscrub-60', 'FSC',  'Foot Scrub',            60, 'single', 1, 0, 100, '2026-11-03T00:00:00.000Z'),
  ('c1', 'C1', 'Swedish + head, back or foot massage',  90, 'combo', 0, 0, 210, '2026-11-03T00:00:00.000Z'),
  ('c2', 'C2', 'Swedish + body scrub',                 120, 'combo', 0, 0, 220, '2026-11-03T00:00:00.000Z'),
  ('c3', 'C3', 'Aroma + head, back or foot massage',   120, 'combo', 0, 0, 230, '2026-11-03T00:00:00.000Z'),
  ('c4', 'C4', 'Hot oil + head, back or foot massage', 120, 'combo', 0, 0, 240, '2026-11-03T00:00:00.000Z'),
  ('c5', 'C5', 'Hot stone + head, back or foot massage', 120, 'combo', 0, 0, 250, '2026-11-03T00:00:00.000Z'),
  ('c6', 'C6', 'Foot scrub + foot massage',             90, 'combo', 1, 0, 260, '2026-11-03T00:00:00.000Z'),
  ('c7', 'C7', 'Ventosa + head, back or foot massage', 120, 'combo', 0, 0, 270, '2026-11-03T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `service_prices` (`id`, `service_id`, `regular_price`, `effective_from`, `created_at`) VALUES
  ('p-foot-60',      'foot-60',      45000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-foot-30',      'foot-30',      25000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-back-60',      'back-60',      45000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-back-30',      'back-30',      25000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-thai-60',      'thai-60',      50000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-swedish-60',   'swedish-60',   50000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-aroma-90',     'aroma-90',     70000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-hotoil-90',    'hotoil-90',    70000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-hotstone-90',  'hotstone-90',  70000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-ventosa-90',   'ventosa-90',   75000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-bodyscrub-60', 'bodyscrub-60', 60000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-footscrub-60', 'footscrub-60', 50000,  '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c1', 'c1',  70000, '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c2', 'c2', 100000, '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c3', 'c3',  90000, '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c4', 'c4',  90000, '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c5', 'c5',  90000, '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c6', 'c6',  70000, '2026-01-01', '2026-11-03T00:00:00.000Z'),
  ('p-c7', 'c7',  90000, '2026-01-01', '2026-11-03T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `promos` (`id`, `name`, `service_id`, `percent_bp`, `start_time`, `end_time`, `valid_from`, `valid_to`, `active`, `created_at`) VALUES
  ('happy-hours', 'Happy Hours', 'swedish-60', 1000, '14:00', '18:00', '2026-01-01', '2026-11-30', 1, '2026-11-03T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `addons` (`id`, `name`, `price`, `active`, `created_at`) VALUES
  ('extra-oil', 'Extra oil', 5000, 1, '2026-11-03T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `rooms` (`id`, `name`, `is_flex`, `active`) VALUES
  (1, 'Room 1', 0, 1), (2, 'Room 2', 0, 1), (3, 'Room 3', 0, 1), (4, 'Room 4', 0, 1),
  (5, 'Room 5', 0, 1), (6, 'Room 6', 0, 1), (7, 'Room 7', 0, 1), (8, 'Room 8 (Flex)', 1, 1);
--> statement-breakpoint
-- Remaining 2026 Philippine holidays. Holiday commission is pre-set on Regular Holidays only: review in Settings.
INSERT INTO `holidays` (`date`, `name`, `type`, `raises_commission`) VALUES
  ('2026-11-30', 'Bonifacio Day', 'regular', 1),
  ('2026-12-08', 'Feast of the Immaculate Conception', 'special', 0),
  ('2026-12-24', 'Christmas Eve', 'special', 0),
  ('2026-12-25', 'Christmas Day', 'regular', 1),
  ('2026-12-30', 'Rizal Day', 'regular', 1),
  ('2026-12-31', 'Last Day of the Year', 'special', 0);
--> statement-breakpoint
INSERT INTO `commission_rates` (`id`, `therapist_class`, `normal_bp`, `holiday_bp`, `effective_from`, `created_at`) VALUES
  ('cr-regular-2020', 'regular', 3000, 5000, '2020-01-01', '2026-11-03T00:00:00.000Z'),
  ('cr-lmt-2020',     'lmt',     4000, 6000, '2020-01-01', '2026-11-03T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `pay_rules` (`key`, `value_json`, `updated_at`) VALUES
  ('receptionist_shift', '{"start":"14:00","end":"23:00","mealBreakMin":60}', '2026-11-03T00:00:00.000Z'),
  ('receptionist_rest_weekday', '0', '2026-11-03T00:00:00.000Z'),
  ('receptionist_premiums', '{"ordinary":{"workedPct":100,"otPct":125},"restDay":{"workedPct":130,"otPct":169},"special":{"workedPct":130,"otPct":169},"specialOnRestDay":{"workedPct":150,"otPct":195},"regular":{"workedPct":200,"otPct":260},"regularOnRestDay":{"workedPct":260,"otPct":338},"regularUnworkedPct":100}', '2026-11-03T00:00:00.000Z'),
  ('gov_deduction_defaults', '{"therapist":{"sss":10000,"phic":6250,"pagibig":4000},"receptionist":{"sss":21250,"phic":10563,"pagibig":5000}}', '2026-11-03T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0003_seed_catalogue' WHERE `key` = 'schema_version';
