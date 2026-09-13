/** Browser-only Protobuf file delivery kept outside the observable UI state bridge. */
export function triggerProtobufDownload(filename: string, data: Uint8Array | null | undefined): void {
  if (!data) return;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy.buffer], { type: 'application/x-protobuf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
