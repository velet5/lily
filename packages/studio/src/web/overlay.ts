// What covers the page while it cannot reach its worker (DECISIONS D55):
// reconnecting, open in another tab, signed out. Edits stay in the editor
// underneath.
export interface OverlayContent {
  title: string
  text: string
  action?: { label: string; run(): void }
}

export class Overlay {
  private element: HTMLElement | undefined

  show(content: OverlayContent): void {
    const element = this.element ?? this.create()
    const title = document.createElement('h2')
    title.textContent = content.title
    const text = document.createElement('p')
    text.textContent = content.text
    const children: HTMLElement[] = [title, text]
    if (content.action) {
      const { label, run } = content.action
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'primary'
      button.textContent = label
      button.addEventListener('click', run)
      children.push(button)
    }
    element.firstElementChild!.replaceChildren(...children)
    element.hidden = false
    element.querySelector('button')?.focus()
  }

  hide(): void {
    if (this.element) this.element.hidden = true
  }

  private create(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'web-overlay'
    element.setAttribute('role', 'alertdialog')
    element.setAttribute('aria-modal', 'true')
    element.append(document.createElement('div'))
    document.body.append(element)
    this.element = element
    return element
  }
}
