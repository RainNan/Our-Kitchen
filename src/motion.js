// One owner per animation; cancel on interruption and remove temporary flight nodes.
export function createMotion() {
  const running = new Map()
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  function animate(element, frames, options, temporary = false, done) {
    if (!element || reduce.matches) { if (temporary) element?.remove(); return }
    running.get(element)?.cancel()
    const animation = element.animate(frames, options)
    running.set(element, animation)
    animation.finished.then(() => {
      if (running.get(element) !== animation) return
      running.delete(element)
      if (temporary) element.remove()
      done?.()
    }).catch(() => { if (temporary) element.remove() })
  }
  function pulse(element) {
    animate(element, [{ transform: 'scale(1)' }, { transform: 'scale(1.23)', offset: .4 }, { transform: 'scale(1)' }], { duration: 190, easing: 'ease-out' })
  }
  function fly(source, target) {
    if (!source || !target || reduce.matches) return
    const from = source.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    const size = 56
    const x = from.left + from.width / 2 - size / 2
    const y = from.top + from.height / 2 - size / 2
    const dx = to.left + to.width / 2 - size / 2 - x
    const dy = to.top + to.height / 2 - size / 2 - y
    const node = document.createElement('div')
    node.className = 'dish-flight'
    node.setAttribute('aria-hidden', 'true')
    node.style.left = `${x}px`
    node.style.top = `${y}px`
    const image = source.querySelector('img')
    if (image) { const copy = document.createElement('img'); copy.src = image.currentSrc || image.src; copy.alt = ''; node.append(copy) }
    else {
      const placeholder = source.querySelector('.food-placeholder')
      if (placeholder) node.append(placeholder.cloneNode(true))
      else { node.textContent = '✦'; node.classList.add('flight-placeholder') }
    }
    // A manual popover keeps the flight visible even when adding from a dialog.
    node.setAttribute('popover', 'manual')
    document.body.append(node)
    if (node.showPopover) node.showPopover()
    else node.removeAttribute('popover')
    const lift = Math.min(100, Math.max(45, Math.abs(dy) * .2))
    const frames = [0, .25, .5, .75, 1].map(t => ({
      transform: `translate(${dx * t}px, ${dy * t - Math.sin(Math.PI * t) * lift}px) scale(${1 - .65 * t}) rotate(${12 * Math.sin(Math.PI * t)}deg)`,
      opacity: t === 1 ? .25 : 1, offset: t,
    }))
    animate(node, frames, { duration: 500, easing: 'cubic-bezier(.3,0,.3,1)' }, true, () => {
      if (target.isConnected) pulse(target)
    })
  }
  function cancelAll() {
    for (const animation of running.values()) animation.cancel()
    running.clear()
  }
  function changed() { if (reduce.matches) cancelAll() }
  window.addEventListener('scroll', cancelAll, true)
  window.addEventListener('resize', cancelAll)
  reduce.addEventListener('change', changed)
  function dispose() {
    cancelAll()
    window.removeEventListener('scroll', cancelAll, true)
    window.removeEventListener('resize', cancelAll)
    reduce.removeEventListener('change', changed)
  }
  return { pulse, fly, cancelAll, dispose }
}
