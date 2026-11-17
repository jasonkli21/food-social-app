import { File, Paths } from 'expo-file-system';
import type { Attachment } from '../types';

export async function keepAttachment(attachment: Attachment, id: string) {
  const ext = attachment.name.match(/\.[a-zA-Z0-9]{2,5}$/)?.[0] ?? '';
  const destination = new File(Paths.document, 'goodfork-' + id + ext);
  new File(attachment.uri).copy(destination);
  return destination.uri;
}

export async function dropAttachment(source: string) {
  if (!source.startsWith('file:') || !source.includes('/goodfork-')) return;
  const file = new File(source);
  if (file.exists) file.delete();
}

export async function resolveAttachment(source: string) {
  return source;
}
