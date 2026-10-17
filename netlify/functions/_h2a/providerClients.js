import { decryptSecret, loadCredentialKeyring } from './crypto.js'
import { HubSpotClient } from './hubspotClient.js'
import { AlbiClient } from './albiClient.js'

const fromRpc = ({ key_version, ...envelope }) => ({ ...envelope, keyVersion: key_version })

export async function createH2AProviderClients({ companyId, repository, keyring, env = process.env, fetch } = {}) {
  const credentials = await repository.getCredentials(companyId)
  if (!credentials?.hubspot_envelope || !credentials?.albi_envelope) throw new Error('H2A credentials are missing')
  const resolvedKeyring = keyring ?? loadCredentialKeyring(env)
  return {
    hubspot: new HubSpotClient({ token: decryptSecret(fromRpc(credentials.hubspot_envelope), resolvedKeyring), fetch }),
    albi: new AlbiClient({ apiKey: decryptSecret(fromRpc(credentials.albi_envelope), resolvedKeyring), fetch }),
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
      ...(typeof albi.listCreateOptions === 'function' ? { listCreateOptions: albi.listCreateOptions.bind(albi) } : {}) }),
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
      createOrganization: clients.albi.createOrganization.bind(clients.albi) }),
  })
}
