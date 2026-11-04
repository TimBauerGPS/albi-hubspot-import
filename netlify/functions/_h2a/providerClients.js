import { decryptSecret, loadCredentialKeyring } from './crypto.js'
import { HubSpotClient } from './hubspotClient.js'
import { AlbiClient } from './albiClient.js'
import { withAlbiMirror } from './albiMirror.js'
import { createAlbiCache } from './albiCache.js'
import { AlbiWrapperClient, withAlbiActivityFallback } from './albiWrapperClient.js'

const fromRpc = ({ key_version, ...envelope }) => ({ ...envelope, keyVersion: key_version })

// An envelope that cannot be decrypted counts as no key: the Public API's refusal then stands and nothing is resent.
export function wrapperClient(envelope, keyring, fetch) {
  if (!envelope) return null
  try { return new AlbiWrapperClient({ apiKey: decryptSecret(fromRpc(envelope), keyring), fetch }) } catch { return null }
}

export async function createH2AProviderClients({ companyId, repository, keyring, env = process.env, fetch } = {}) {
  const credentials = await repository.getCredentials(companyId)
  if (!credentials?.hubspot_envelope || !credentials?.albi_envelope) throw new Error('H2A credentials are missing')
  const resolvedKeyring = keyring ?? loadCredentialKeyring(env)
  const albiApiKey = decryptSecret(fromRpc(credentials.albi_envelope), resolvedKeyring)
  return {
    hubspot: new HubSpotClient({ token: decryptSecret(fromRpc(credentials.hubspot_envelope), resolvedKeyring), fetch }),
    // Contact and organization lists come from the company's Albi copy, refreshed with what changed in Albi.
    // Activity reads fall back to the wrapper while the Albi key lacks the scope.
    albi: withAlbiActivityFallback(withAlbiMirror(new AlbiClient({ apiKey: albiApiKey, fetch,
      cache: createAlbiCache({ store: repository, companyId, apiKey: albiApiKey }) }), { store: repository, companyId }), wrapperClient(await repository.getAlbiWrapperCredential?.(companyId), resolvedKeyring, fetch)),
  }
}

// Select and bind read methods explicitly; never enumerate a client or touch a write getter.
export function readOnlyH2ACapabilities({ hubspot, albi }) {
  const direct = {
    ...(typeof hubspot.getContact === 'function' ? { getContact: hubspot.getContact.bind(hubspot) } : {}),
    ...(typeof hubspot.getCompany === 'function' ? { getCompany: hubspot.getCompany.bind(hubspot) } : {}),
  }
  return {
    hubspotRead: Object.freeze({ ...direct,
      getContacts: hubspot.getContacts.bind(hubspot), getCompanies: hubspot.getCompanies.bind(hubspot),
      getAssociations: hubspot.getAssociations.bind(hubspot),
      ...(typeof hubspot.getOwnerId === 'function' ? { getOwnerId: hubspot.getOwnerId.bind(hubspot) } : {}),
      ...(typeof hubspot.getMergedInto === 'function' ? { getMergedInto: hubspot.getMergedInto.bind(hubspot) } : {}),
      ...(typeof hubspot.listOwners === 'function' ? { listOwners: hubspot.listOwners.bind(hubspot) } : {}) }),
    albiRead: Object.freeze({ listContacts: albi.listContacts.bind(albi), listOrganizations: albi.listOrganizations.bind(albi),
      ...(typeof albi.listReferralSources === 'function' ? { listReferralSources: albi.listReferralSources.bind(albi) } : {}),
      ...(typeof albi.listCreateOptions === 'function' ? { listCreateOptions: albi.listCreateOptions.bind(albi) } : {}),
      ...(typeof albi.getOrganization === 'function' ? { getOrganization: albi.getOrganization.bind(albi) } : {}) }),
  }
}

// Bind only the writes allowed by record resolution. Never enumerate providers.
export function reviewResolutionProviderCapabilities(clients) {
  const reads = readOnlyH2ACapabilities(clients)
  return Object.freeze({ ...reads,
    hubspotWrite: Object.freeze({ updateContact: clients.hubspot.updateContact.bind(clients.hubspot),
      updateCompany: clients.hubspot.updateCompany.bind(clients.hubspot),
      addContactCompanyAssociation: clients.hubspot.addContactCompanyAssociation.bind(clients.hubspot) }),
    albiWrite: Object.freeze({ createContact: clients.albi.createContact.bind(clients.albi),
      createOrganization: clients.albi.createOrganization.bind(clients.albi),
      updateContact: clients.albi.updateContact.bind(clients.albi),
      updateOrganization: clients.albi.updateOrganization.bind(clients.albi) }),
  })
}
