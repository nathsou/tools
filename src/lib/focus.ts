/** Keep keyboard focus in preferences and return it to the opener when closed. */
export function focusDialog(node:HTMLElement) {
  const previous=document.activeElement as HTMLElement|null;
  const controls=()=>Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
  queueMicrotask(()=>{ if (node.isConnected) (controls()[0] ?? node).focus(); });
  const keydown=(event:KeyboardEvent)=>{
    if (event.key !== 'Tab') return;
    const items=controls(), first=items[0], last=items.at(-1);
    if (!first) { event.preventDefault(); node.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last!.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  node.addEventListener('keydown',keydown);
  return { destroy() { node.removeEventListener('keydown',keydown); queueMicrotask(()=>{ if (previous?.isConnected) previous.focus(); }); } };
}
