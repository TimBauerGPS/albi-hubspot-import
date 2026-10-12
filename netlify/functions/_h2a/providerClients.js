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
  return {
    hubspotRead: Object.freeze({ getContacts: hubspot.getContacts.bind(hubspot), getCompanies: hubspot.getCompanies.bind(hubspot),
      getAssociations: hubspot.getAssociations.bind(hubspot) }),
    albiRead: Object.freeze({ listContacts: albi.listContacts.bind(albi), listOrganizations: albi.listOrganizations.bind(albi) }),
  }
}
