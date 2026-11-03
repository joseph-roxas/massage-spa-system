import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Close on a backdrop click only if the press started there too: a slow tap on a button
  // whose dialog shrinks before release must not close it.
  const pressedBackdrop = useRef(false);

  return (
    <div
      className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-stone-900/50 p-4 pt-16"
      onPointerDown={(e) => (pressedBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => e.target === e.currentTarget && pressedBackdrop.current && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-xl rounded-xl bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" aria-label="Close" className="text-stone-400 hover:text-stone-700" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
