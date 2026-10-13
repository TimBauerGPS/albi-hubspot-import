import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
