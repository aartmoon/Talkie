type UserAvatarProps = {
  username: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

function initialsFrom(username: string): string {
  const normalized = username.trim();
  if (!normalized) return '?';
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

export function UserAvatar({ username, avatarUrl, size = 'md', className = '' }: UserAvatarProps) {
  const classes = `user-avatar ${size} ${className}`.trim();
  if (avatarUrl) {
    return <img className={classes} src={avatarUrl} alt={username} loading="lazy" />;
  }
  return <span className={`${classes} fallback`}>{initialsFrom(username)}</span>;
}
