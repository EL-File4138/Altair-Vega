import { onMount, onCleanup } from 'solid-js'

import './ImageViewer.css'

type ImageViewerProps = {
  src: string
  alt: string
  onClose: () => void
}

export default function ImageViewer(props: ImageViewerProps) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose()
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <div class="image-viewer" role="dialog" aria-label="Image viewer" onClick={props.onClose}>
      <button class="image-viewer__close btn btn-ghost btn-icon" type="button" onClick={props.onClose} aria-label="Close viewer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12m0-12L6 18" />
        </svg>
      </button>
      <img
        class="image-viewer__img"
        src={props.src}
        alt={props.alt}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
