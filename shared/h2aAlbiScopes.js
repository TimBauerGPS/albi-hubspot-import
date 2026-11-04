// Albi Public API scope keys (https://albi-public.readme.io/docs/authentication-and-scopes) that the H2A
// module may name in a permission failure. Anything else is never shown.
export const ALBI_SCOPES = Object.freeze({
  contactsView: 'Permissions.Contacts.View',
  contactsCreate: 'Permissions.Contacts.Create',
  contactsEdit: 'Permissions.Contacts.Edit',
  organizationsView: 'Permissions.Organizations.View',
  organizationsCreate: 'Permissions.Organizations.Create',
  organizationsEdit: 'Permissions.Organizations.Edit',
  activitiesView: 'Permissions.Activities.View',
  activitiesEdit: 'Permissions.Activities.Edit',
  usersView: 'Permissions.Users.View',
  companyView: 'Permissions.Company.View',
  // The Guardian wrapper's own scope, for its activity read (albiWrapperClient.js).
  wrapperActivitiesList: 'activities:list',
})

export const KNOWN_ALBI_SCOPES = new Set(Object.values(ALBI_SCOPES))
