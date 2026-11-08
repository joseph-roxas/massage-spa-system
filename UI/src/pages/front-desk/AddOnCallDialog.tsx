import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useDeskAction } from '../../lib/front-desk';

/** Adds an On-call Therapist from the desk, with no wait for the Super Admin. */
export function AddOnCallDialog({ onClose }: { onClose: () => void }) {
  const add = useDeskAction();
  const [f, setF] = useState({ lastName: '', firstName: '', displayName: '', pin: '' });
  const [added, setAdded] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate({ path: '/on-call-therapists', body: { ...f, displayName: f.displayName || undefined } }, { onSuccess: () => setAdded(f.displayName || f.firstName) });
  }

  if (added) {
    return (
      <Modal title="On-call therapist added" onClose={onClose}>
        <div className="space-y-4">
          <Alert tone="success">{added} can now clock in with their PIN and will join the Rotation.</Alert>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
            <Link to="/clock" className="inline-flex h-10 items-center rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800">
              Clock-in Screen
            </Link>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add an on-call therapist" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-stone-600">For someone called in to help with extra guests. They are paid their Commission at Day Close, at the regular rate.</p>
        {add.error && <Alert>{add.error.message}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Surname">
            <Input required autoFocus value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} />
          </Field>
          <Field label="First name">
            <Input required value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} />
          </Field>
          <Field label="Shown as" hint="On the Clock-in Screen and Rotation">
            <Input maxLength={40} value={f.displayName} placeholder={f.firstName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
          </Field>
          <Field label="PIN" hint="4 digits, for clocking in">
            <Input required inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={add.isPending}>Add therapist</Button>
        </div>
      </form>
    </Modal>
  );
}
