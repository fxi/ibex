import { useEffect, useId, useRef } from "react";

/**
 * A question the rest of the app waits on: deleting, or choosing how to convert.
 *
 * The native modal `<dialog>` makes the page behind it inert, so a second delete cannot be
 * started under the first, and it brings Escape and focus return with it. It opens in the
 * top layer, outside the panel's scrolling and clipping, so a narrow card no longer decides
 * how much room the question has. Mounted means open: the caller renders it or not.
 */
export function Modal({
  title,
  onClose,
  alert = false,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  /** For a destructive question, announced as one. */
  alert?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal glass"
      role={alert ? "alertdialog" : undefined}
      aria-labelledby={heading}
      // Escape closes the dialog natively; the caller's state has to follow. A `close` that
      // arrives while the dialog is open again is stale: StrictMode's mount, cleanup, mount
      // closes and reopens it, and the queued event from that first close would otherwise
      // unmount it the moment it appears (dev only, so builds and tests never saw it).
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      // The dialog box itself has no padding, so a click on it is a click on the backdrop.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-body">
        <h2 id={heading}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
