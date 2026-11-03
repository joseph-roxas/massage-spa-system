import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { commissionRates, payRules, staff, STAFF_KINDS, THERAPIST_CLASSES } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { basisPoints, centavos, hhmm, name, notInPast } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';
import { hashPassword } from '../auth/password';

const manage = requireCapability('settings.manage');

// ---- Pay rules: one schema per key ----

const premium = z.object({ workedPct: z.number().min(0).max(1000), otPct: z.number().min(0).max(1000) });
const govShares = z.object({ sss: centavos, phic: centavos, pagibig: centavos });

export const PAY_RULE_SCHEMAS = {
  receptionist_shift: z
    .object({ start: hhmm, end: hhmm, mealBreakMin: z.number().int().min(0).max(240) })
    .refine((s) => s.end > s.start, 'Shift end must be after start.'),
  receptionist_rest_weekday: z.number().int().min(0).max(6),
  receptionist_premiums: z.object({
    ordinary: premium,
    restDay: premium,
    special: premium,
    specialOnRestDay: premium,
    regular: premium,
    regularOnRestDay: premium,
    regularUnworkedPct: z.number().min(0).max(1000),
  }),
  gov_deduction_defaults: z.object({ therapist: govShares, receptionist: govShares }),
} as const;

type PayRuleKey = keyof typeof PAY_RULE_SCHEMAS;
const isPayRuleKey = (k: string): k is PayRuleKey => k in PAY_RULE_SCHEMAS;

// ---- Staff ----

const staffFields = z.object({
  firstName: name,
  lastName: name,
  displayName: z.string().trim().min(1).max(40),
  kind: z.enum(STAFF_KINDS),
  therapistClass: z.enum(THERAPIST_CLASSES).nullable(),
  isOnCall: z.boolean(),
  dailyRate: centavos.nullable(),
  govSss: centavos,
  govPhic: centavos,
  govPagibig: centavos,
  active: z.boolean(),
});

type StaffFields = z.infer<typeof staffFields>;

/** Rules that tie the fields together, checked on the merged record. */
function staffProblem(s: StaffFields): string | null {
  if (s.kind === 'therapist' && !s.therapistClass) return 'Pick Regular Therapist or LMT.';
  if (s.kind === 'receptionist' && s.therapistClass) return 'A receptionist has no therapist class.';
  if (s.kind === 'receptionist' && s.isOnCall) return 'Only therapists can be on-call.';
  if (s.kind === 'receptionist' && s.dailyRate == null) return 'A receptionist needs a daily rate.';
  if (s.isOnCall && s.govSss + s.govPhic + s.govPagibig > 0) {
    return 'On-call therapists have no government deductions.';
  }
  return null;
}

const newStaff = staffFields.partial({
  isOnCall: true,
  dailyRate: true,
  therapistClass: true,
  govSss: true,
  govPhic: true,
  govPagibig: true,
  active: true,
});

const pinBody = z.object({ pin: z.string().regex(/^\d{4}$/, 'The PIN must be exactly 4 digits.') });

/** Every column except the PIN hash. */
const staffColumns = {
  id: staff.id,
  firstName: staff.firstName,
  lastName: staff.lastName,
  displayName: staff.displayName,
  kind: staff.kind,
  therapistClass: staff.therapistClass,
  isOnCall: staff.isOnCall,
  dailyRate: staff.dailyRate,
  govSss: staff.govSss,
  govPhic: staff.govPhic,
  govPagibig: staff.govPagibig,
  userId: staff.userId,
  active: staff.active,
  createdAt: staff.createdAt,
  pinHash: staff.pinHash,
};

function withoutPin<T extends { pinHash: string | null }>({ pinHash, ...rest }: T) {
  return { ...rest, hasPin: pinHash !== null };
}

const newRate = z.object({
  therapistClass: z.enum(THERAPIST_CLASSES),
  normalBp: basisPoints,
  holidayBp: basisPoints,
  effectiveFrom: notInPast('Effective date'),
});

export const staffRoutes = new Hono<AuthedEnv>()
  .use(requireAuth, manage)
  .get('/staff', async (c) => {
    const rows = await c.var.db.select(staffColumns).from(staff).orderBy(asc(staff.kind), asc(staff.displayName));
    return c.json({ staff: rows.map(withoutPin) });
  })
  .post('/staff', zValidator('json', newStaff, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const isOnCall = input.isOnCall ?? false;
    // Government Deductions default from Settings unless given (and are always zero when on-call).
    const defaultsRow = await db.select().from(payRules).where(eq(payRules.key, 'gov_deduction_defaults')).get();
    const defaults = defaultsRow
      ? PAY_RULE_SCHEMAS.gov_deduction_defaults.parse(JSON.parse(defaultsRow.valueJson))[input.kind]
      : { sss: 0, phic: 0, pagibig: 0 };
    const record: StaffFields = {
      ...input,
      therapistClass: input.therapistClass ?? null,
      isOnCall,
      dailyRate: input.dailyRate ?? null,
      govSss: input.govSss ?? (isOnCall ? 0 : defaults.sss),
      govPhic: input.govPhic ?? (isOnCall ? 0 : defaults.phic),
      govPagibig: input.govPagibig ?? (isOnCall ? 0 : defaults.pagibig),
      active: input.active ?? true,
    };
    const problem = staffProblem(record);
    if (problem) return fail(c, 400, 'invalid_staff', problem);
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(staff).values({ id, ...record, createdAt: nowIso() }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'staff.create', entity: 'staff', entityId: id, after: record }),
    ]);
    return c.json({ id }, 201);
  })
  .patch('/staff/:id', zValidator('json', staffFields.omit({ kind: true }).partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const before = await db.select().from(staff).where(eq(staff.id, id)).get();
    if (!before) return fail(c, 404, 'not_found', 'Staff member not found.');
    const changes = c.req.valid('json');
    const problem = staffProblem({ ...before, ...changes });
    if (problem) return fail(c, 400, 'invalid_staff', problem);
    await db.batch([
      db.update(staff).set(changes).where(eq(staff.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'staff.update', entity: 'staff', entityId: id, before: withoutPin(before), after: changes }),
    ]);
    return c.json({ ok: true });
  })
  .post('/staff/:id/pin', zValidator('json', pinBody, invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const person = await db.select({ id: staff.id }).from(staff).where(eq(staff.id, id)).get();
    if (!person) return fail(c, 404, 'not_found', 'Staff member not found.');
    await db.batch([
      db.update(staff).set({ pinHash: await hashPassword(c.req.valid('json').pin) }).where(eq(staff.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'staff.pin_set', entity: 'staff', entityId: id }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Commission rates ----
  .get('/commission-rates', async (c) => {
    const rows = await c.var.db
      .select()
      .from(commissionRates)
      .orderBy(asc(commissionRates.therapistClass), asc(commissionRates.effectiveFrom));
    return c.json({ commissionRates: rows });
  })
  .post('/commission-rates', zValidator('json', newRate, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const id = crypto.randomUUID();
    const clash = await db
      .select({ id: commissionRates.id, effectiveFrom: commissionRates.effectiveFrom })
      .from(commissionRates)
      .where(eq(commissionRates.therapistClass, input.therapistClass))
      .all();
    if (clash.some((r) => r.effectiveFrom === input.effectiveFrom)) {
      return fail(c, 409, 'date_taken', 'A rate for this class already starts on that date.');
    }
    await db.batch([
      db.insert(commissionRates).values({ id, ...input, createdAt: nowIso(), createdBy: c.var.user.id }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'commission_rate.add', entity: 'commission_rate', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })

  // ---- Pay rules ----
  .get('/pay-rules', async (c) => {
    const rows = await c.var.db.select().from(payRules).all();
    return c.json({ payRules: Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.valueJson) as unknown])) });
  })
  .put('/pay-rules/:key', zValidator('json', z.object({ value: z.unknown() }), invalidInput), async (c) => {
    const key = c.req.param('key');
    if (!isPayRuleKey(key)) return fail(c, 404, 'not_found', 'Unknown pay rule.');
    const parsed = PAY_RULE_SCHEMAS[key].safeParse(c.req.valid('json').value);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', message: 'That value is not valid.', issues: parsed.error.issues }, 400);
    }
    const db = c.var.db;
    const before = await db.select().from(payRules).where(eq(payRules.key, key)).get();
    const valueJson = JSON.stringify(parsed.data);
    const now = nowIso();
    await db.batch([
      db
        .insert(payRules)
        .values({ key, valueJson, updatedAt: now, updatedBy: c.var.user.id })
        .onConflictDoUpdate({ target: payRules.key, set: { valueJson, updatedAt: now, updatedBy: c.var.user.id } }),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'pay_rule.update',
        entity: 'pay_rule',
        entityId: key,
        before: before ? JSON.parse(before.valueJson) : undefined,
        after: parsed.data,
      }),
    ]);
    return c.json({ ok: true });
  });
