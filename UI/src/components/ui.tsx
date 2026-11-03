import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

const BUTTON_VARIANTS = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-teal-700/50',
  secondary: 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-100 disabled:opacity-50',
  danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50',
} as const;

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}

const CONTROL =
  'h-10 w-full rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={CONTROL} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={CONTROL} {...props} />;
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white">
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <h2 className="font-semibold text-stone-800">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-sm font-semibold uppercase tracking-widest text-teal-700">Spa System</p>
        <div className="rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
