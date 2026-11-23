/** The default picture beside every login's name: a woman with dark shoulder-length hair in the shop's teal. */
export function DefaultAvatar({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={`${className} shrink-0`} role="img" aria-label="Avatar">
      <defs>
        <clipPath id="avatar-circle">
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath="url(#avatar-circle)">
        <circle cx="32" cy="32" r="32" fill="#d4ebf7" />
        {/* Hair behind the head, falling to the shoulders */}
        <path d="M15.5 33C15.5 19 22.5 10.5 32 10.5S48.5 19 48.5 33l1 13.5c-3.5 2.2-8 2.4-11.5.5H26c-3.5 1.9-8 1.7-11.5-.5z" fill="#2b211d" />
        {/* Neck */}
        <path d="M27.5 37h9v8.5L32 49l-4.5-3.5z" fill="#e9b48f" />
        {/* Teal top with a white collar */}
        <path d="M8 66c0-12.5 9.5-20 24-20s24 7.5 24 20z" fill="#0f766e" />
        <path d="M24.5 46.2 32 54.5l7.5-8.3-3.2-1.2L32 50.2 27.7 45z" fill="#ffffff" />
        {/* Face */}
        <ellipse cx="32" cy="29.5" rx="9.6" ry="11.2" fill="#f6cfb0" />
        {/* Side-swept bangs */}
        <path d="M22.2 28.5C21.4 19.5 26 14.5 32.3 14.5c6.6 0 10.6 5 9.6 13.5-2.4-4.6-7.2-7.4-13.6-6.6-2.6 1.6-4.8 4-6.1 7.1z" fill="#2b211d" />
        {/* Eyes, cheeks and smile */}
        <circle cx="28.3" cy="30.2" r="1.15" fill="#3a2a24" />
        <circle cx="35.7" cy="30.2" r="1.15" fill="#3a2a24" />
        <circle cx="26.3" cy="34" r="1.8" fill="#f2a7a0" opacity="0.55" />
        <circle cx="37.7" cy="34" r="1.8" fill="#f2a7a0" opacity="0.55" />
        <path d="M29.6 35.4q2.4 2 4.8 0" fill="none" stroke="#b5654f" strokeWidth="1.1" strokeLinecap="round" />
      </g>
    </svg>
  );
}
