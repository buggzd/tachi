/** Android's unfocused external WebView can move activeElement without focusin. */
export function focusWithNotification(element: HTMLElement, options: FocusOptions, changed: boolean) {
  const previous = element.ownerDocument.activeElement
  let notified = false
  const observe = (event: FocusEvent) => { if (event.target === element) notified = true }
  element.addEventListener('focusin', observe)
  try {
    element.focus(options)
  } finally {
    element.removeEventListener('focusin', observe)
  }
  // React's onFocus/onFocusCapture consume focusin. Keep logical selection and
  // preview/region state aligned even while the phone owns window focus.
  if (changed && !notified && element.isConnected) {
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: previous }))
  }
}
