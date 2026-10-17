import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { presentSampleReviewItem } from '../../src/features/hubspotToAlbi/sampleReview.js'
import { buildResolutionConfirmation } from '../../src/features/hubspotToAlbi/sampleReviewResolution.js'

export async function mountSampleReviewResolution(item, onResolve, onOpenOrganization, onOpenMergedSurvivor) {
  const source = await readFile(new URL('../../src/features/hubspotToAlbi/SampleReviewResolution.jsx', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default function', 'function'),
    { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code
  const slots = [], effects = [], pending = []; let index = 0, tree, dirty = true, ids = 0
  const useState = initial => { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; dirty = true }] }
  const useRef = initial => { const slot = index++; return slots[slot] ??= { current: initial } }
  const documentState = { activeElement: null }
  const h = (type, props, ...children) => {
    const node = { type: typeof type === 'function' ? type.name : type, props: props ?? {}, children: children.flat(Infinity) }
    node.dom = { isConnected: true, focus() { documentState.activeElement = node.dom },
      querySelectorAll() {
        const controls = []
        const visit = current => {
          if (!current || typeof current !== 'object') return
          if ((['button', 'input', 'select', 'a'].includes(current.type) && !current.props.disabled) ||
            Number.isInteger(current.props.tabIndex) && current.props.tabIndex >= 0) controls.push(current.dom)
          current.children?.forEach(visit)
        }
        node.children.forEach(visit)
        return controls
      } }
    return node
  }
  const useEffect = (run, deps) => {
    const slot = index++, prior = effects[slot]
    if (!prior || !deps || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
      pending.push(() => { prior?.cleanup?.(); effects[slot] = { deps, cleanup: run() } })
    }
  }
  const Component = vm.runInNewContext(`${code}\nSampleReviewResolution`, { h, Fragment: 'fragment', useState, useRef,
    useEffect, presentSampleReviewItem, buildResolutionConfirmation,
    crypto: { randomUUID: () => (++ids === 1 ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') },
    document: documentState, Date, Intl, Object, Set })
  const nodes = (root = tree) => { const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); node.children?.forEach(walk) }; walk(root); return all }
  const flush = async () => { for (let n = 0; n < 12; n++) { if (dirty) { dirty = false; index = 0; tree = Component({ item, onResolve, onOpenOrganization, onOpenMergedSurvivor })
      for (const node of nodes()) if (node.props?.ref) node.props.ref.current = node.dom
      while (pending.length) pending.shift()() }
    await Promise.resolve() } }
  await flush()
  return { flush, nodes, documentState, text: () => JSON.stringify(tree),
    find: (type, label) => nodes().find(node => node.type === type && JSON.stringify(node.children).includes(label)) }
}

// Real page JSX and React rendering; only scheduling and unrelated setup forms are substituted.
export async function renderWorkflowPage(name, data, bindings, { isAdmin = true } = {}) {
  const source = await readFile(new URL(`../../src/features/hubspotToAlbi/${name}.jsx`, import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
    .replace('export default function', 'function'), { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code
  let slot = 0
  const useState = initial => {
    const index = slot++
    const value = index === 0 ? data : name === 'SettingsPage' && index === 1 ? data.config.selected_start_date
      : initial === true ? false : typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  }
  const context = { ...bindings, h: createElement, Fragment, useState, useRef: initial => ({ current: initial }),
    useMemo: callback => callback(), useCallback: callback => callback, useEffect() {},
    useOutletContext: () => ({ session: { access_token: 'token' }, companyId: 'company-1', companyName: 'Example',
      isAdmin, tenantRevision: 0, completeTenantTransition() {} }),
    Link: ({ to, children, ...props }) => createElement('a', { href: to, ...props }, children),
    CredentialFields: () => null, OptionMappingForm: () => null, PreflightChecklist: () => null,
    Date, Intl, Set, Map, AbortController,
  }
  const component = vm.runInNewContext(`${code}\n${name}`, context)
  return renderToStaticMarkup(createElement(component))
}

// Run real page handlers with persistent hook state and effect scheduling, doubling only HTTP.
export async function mountWorkflowPage(name, bindings) {
  const source = await readFile(new URL(`../../src/features/hubspotToAlbi/${name}.jsx`, import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
    .replace('export default function', 'function'), { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code
  const slots = [], effects = [], pending = [], requests = []
  let index = 0, tree, dirty = true
  const context = { session: { access_token: 'token' }, companyId: 'company-1', companyName: 'Example',
    isAdmin: true, tenantRevision: 0, completeTenantTransition() {} }
  const useState = initial => {
    const slot = index++
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; dirty = true }]
  }
  const useRef = initial => { const slot = index++; return slots[slot] ??= { current: initial } }
  const useEffect = (run, deps) => {
    const slot = index++, prior = effects[slot]
    if (!prior || !deps || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
      pending.push(() => { prior?.cleanup?.(); effects[slot] = { deps, cleanup: run() } })
    }
  }
  const useCallback = (callback, deps) => {
    const ref = useRef()
    if (!ref.current || deps.some((value, i) => !Object.is(value, ref.current.deps[i]))) ref.current = { callback, deps }
    return ref.current.callback
  }
  const h = (type, props, ...children) => ({ type: typeof type === 'function' ? type.name : type,
    props: props ?? {}, children: children.flat(Infinity) })
  const component = vm.runInNewContext(`${code}\n${name}`, { ...bindings, h, Fragment: 'fragment',
    useState, useRef, useEffect, useCallback, useMemo: callback => callback(), useOutletContext: () => context,
    Link: function Link() {}, Date, Intl, Set, Map, AbortController,
    getH2AOverview: (...args) => { requests.push(args); return bindings.getH2AOverview(...args) },
  })
  async function flush() {
    for (let attempt = 0; attempt < 16; attempt++) {
      if (dirty) { dirty = false; index = 0; tree = component(); while (pending.length) pending.shift()() }
      await Promise.resolve(); await Promise.resolve()
    }
  }
  const nodes = (root = tree) => {
    const result = []
    const visit = node => { if (!node || typeof node !== 'object') return; result.push(node); node.children?.forEach(visit) }
    visit(root)
    return result
  }
  await flush()
  return { context, requests, flush, nodes, state: () => slots[0], text: () => JSON.stringify(tree),
    rerender: () => { dirty = true; return flush() },
    find: (type, text) => nodes().find(node => node.type === type && JSON.stringify(node.children).includes(text)),
    unmount: () => effects.forEach(effect => effect?.cleanup?.()) }
}
