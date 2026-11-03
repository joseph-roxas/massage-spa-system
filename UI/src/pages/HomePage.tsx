import { Card } from '../components/ui';
import { useCurrentUser } from '../lib/auth';

export function HomePage() {
  const { data: user } = useCurrentUser();
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Good day, {user?.firstName}</h1>
      <Card title="Front Desk">
        <p className="text-sm text-stone-600">
          Bookings, the therapist rotation and checkout arrive in the next phases. For now you can manage your
          password{user?.role === 'super_admin' ? ' and approve new users' : ''}.
        </p>
      </Card>
    </div>
  );
}
