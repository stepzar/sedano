import { useRef } from 'react'
import { ATTACH_ACCEPT } from '../attachments.ts'
import { IconAttach } from './Icons.tsx'

/**
 * Pick images (photo library, camera) or text files. Paste and drag-and-drop
 * are awkward on a phone; this hands the files to the same pipeline they use,
 * so pictures get their `[image:N]` chips and text files their document tiles.
 */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        className="icon-btn attach-btn"
        title="Attach images or text files"
        aria-label="Attach images or text files"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <IconAttach size={17} />
      </button>
      <input
        ref={input}
        type="file"
        accept={ATTACH_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          // Cleared so picking the same file twice still fires a change.
          event.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </>
  )
}
