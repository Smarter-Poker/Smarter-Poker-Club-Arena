import { useState } from 'react';

export default function ClubDashboardAvatar({ src, name }: { src?: string; name: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  if (!src || failedSource === src) return <span>{name.charAt(0)}</span>;
  return <img src={src} alt={name} loading="lazy" onError={() => setFailedSource(src)} />;
}
