'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Editor from '@/components/Editor';

function EditorWithParams() {
  const params = useSearchParams();
  const slug = params.get('slug') ?? params.get('url') ?? '';
  const name = params.get('name') ?? '';
  return <Editor key={slug} initialSlug={slug} initialName={name} />;
}

export default function EditPage() {
  return (
    <Suspense fallback={<div className="card">Loading editor…</div>}>
      <EditorWithParams />
    </Suspense>
  );
}
