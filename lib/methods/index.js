const Hoek = require('hoek')
const url = require('url')
const qs = require('querystring')
const debug = require('debug')('defra.identity:methods')
const uuidv4 = require('uuid/v4')

const registerDynamicsMethods = require('./dynamics')

module.exports = (
  {
    server,
    cache,
    config,
    internals
  }) => {
  debug('Registering server methods...')

  /**
   * Gets the user's session credentials - i.e. refresh token, expiry times of credentials
   *
   * @param {object} request - hapi request object
   * @returns {object|Boolean}
   */
  const getCredentials = async (request) => {
    Hoek.assert(typeof request === 'object', 'request object must be passed to idm.getCredentials')

    let cacheKey

    try {
      cacheKey = request.state[config.cookieName].sub
    } catch (e) {
      return false
    }

    if (!cacheKey) { return false }

    const cacheData = await cache.get(cacheKey)

    if (cacheData && typeof cacheData === 'object') {
      cacheData.isExpired = function () {
        const nowTimestamp = ((new Date()).getTime()) / 1000

        return !this.claims || (this.claims.exp < nowTimestamp)
      }
    }

    return cacheData
  }

  /**
   * Gets the user's claims
   *
   * @param {object} request - hapi request object
   * @returns {object|null}
   */
  const getClaims = async (request) => {
    Hoek.assert(typeof request === 'object', 'request object must be passed to idm.getClaims')

    const credentials = await server.methods.idm.getCredentials(request)

    if (credentials) { return credentials.claims }

    return null
  }

  /**
   * Gets a url to the plugin's outboundPath
   *
   * @param {string} backToPath - Where to send the user after they have logged in
   * @param {object} obj
   * @param {string} obj.policyName - The name of the policy the user should be sent to in B2C
   * @param {string} obj.journey - The name of the policy the user should be sent to in the identity app
   * @param {Boolean} obj.forceLogin - Whether the user should be forced to log in or not - ignores whether they are already logged in at the IdP
   * @param {Boolean} obj.returnUrlObject - Whether to return a url object. By default returns the url as a string
   */
  const generateAuthenticationUrl = (backToPath, { policyName, journey, forceLogin = false, returnUrlObject = false } = {}) => {
    backToPath = backToPath || config.defaultBackToPath

    const outboundUrl = url.parse(config.appDomain)

    outboundUrl.pathname = config.outboundPath

    outboundUrl.query = {
      backToPath,
      policyName,
      journey,
      forceLogin: forceLogin ? 'yes' : undefined
    }

    if (returnUrlObject) { return outboundUrl }

    return outboundUrl.format()
  }

  /**
   * Logs the user out
   *
   * @param {object} request - hapi request object
   */
  const logout = async (request) => {
    Hoek.assert(typeof request === 'object', 'request object must be passed to idm.logout')

    let cacheKey

    try {
      cacheKey = request.state[config.cookieName].sub
    } catch (e) {}

    if (cacheKey) { await cache.drop(cacheKey) }

    request.cookieAuth.clear()
  }

  /**
   * Refreshes the user's JWT
   *
   * @param {object} request - hapi request object
   * @param {string} refreshToken - The current JWT's refresh token - Can be retrieved from `server.methods.idm.getCredentials()`
   * @param {string} policyName - The policy the user was authenticated via when the JWT was issued
   */
  const refreshToken = async (request, refreshToken, policyName) => {
    const client = await internals.client.getClient({ policyName })

    const tokenSet = await client.refresh(refreshToken)

    internals.routes.storeTokenSetResponse(request, tokenSet)

    debug('refreshed and validated tokens %j', tokenSet)
    debug('refreshed id_token claims %j', tokenSet.claims)
  }

  /**
   *
   * @param {object} obj
   * @param {string} obj.backToPath - Where to send the user after they have logged in
   * @param {string} obj.policyName - The name of the policy the user should be sent to in B2C
   * @param {string} obj.journey - The name of the journey the user should be sent to in the identity app
   * @param {Boolean} obj.forceLogin - Whether the user should be forced to log in or not - ignores whether they are already logged in at the IdP
   */
  const generateFirstStageOutboundRedirectUrl = async ({ backToPath, policyName, forceLogin, journey }, { state = null, stateCacheData = {} } = {}) => {
    policyName = policyName || config.defaultPolicy
    journey = journey || config.defaultJourney
    state = state || uuidv4()

    if (forceLogin === 'yes') { forceLogin = true }

    stateCacheData = Hoek.applyToDefaults({
      policyName,
      forceLogin,
      backToPath,
      journey
    }, stateCacheData)

    await cache.set(state, stateCacheData)

    const identityAppUrl = url.parse(config.identityAppUrl)

    identityAppUrl.pathname = '/auth'

    identityAppUrl.query = {
      redirect_uri: config.redirectUriFqdn,
      forceLogin: forceLogin ? 'yes' : undefined,
      policyName,
      journey,
      state,
      client_id: config.clientId,
      serviceId: config.serviceId
    }

    return identityAppUrl.format()
  }

  /**
   * Saves the user guid state in cache and generates an IdP url to send the user to. This is the function used by the outbound path route handler
   *
   * @param {object} obj
   * @param {string} obj.backToPath - Where to send the user after they have logged in
   * @param {string} obj.policyName - The name of the policy the user should be sent to
   * @param {Boolean} obj.forceLogin - Whether the user should be forced to log in or not - ignores whether they are already logged in at the IdP
   * @param {object} obj2
   * @param {string} obj2.state - Manually specify the state uid to be assigned to the user's cache entry
   * @param {object} obj2.stateCacheData - Any extra data to be stored in the user's cache entry - used when the user is sent on a reset password journey
   *
   * @returns {string} IdP authentication url
   */
  const generateFinalOutboundRedirectUrl = async ({ backToPath, policyName, forceLogin, journey }, { state = null, stateCacheData = {}, redirectUri = null, clientId = null } = {}) => {
    policyName = policyName || config.defaultPolicy
    journey = journey || config.defaultJourney
    state = state || uuidv4()
    redirectUri = redirectUri || config.redirectUriFqdn

    if (forceLogin === 'yes') {
      forceLogin = true
    }

    stateCacheData = Hoek.applyToDefaults({
      policyName,
      forceLogin,
      backToPath,
      journey
    }, stateCacheData)

    await cache.set(state, stateCacheData)

    const client = await internals.client.getClient({ policyName })

    let authorizationUrl = client.authorizationUrl({
      redirect_uri: redirectUri,
      scope: 'openid offline_access',
      response_mode: 'form_post',
      state
    })

    const parsedAuthorizationUrl = url.parse(authorizationUrl)

    if (typeof parsedAuthorizationUrl.query === 'string') {
      parsedAuthorizationUrl.query = qs.parse(parsedAuthorizationUrl.query)
      delete parsedAuthorizationUrl.search
    }

    parsedAuthorizationUrl.query.journey = journey

    if (forceLogin) {
      parsedAuthorizationUrl.query.prompt = 'login'
    }

    if (clientId) {
      parsedAuthorizationUrl.query.client_id = clientId
    }

    authorizationUrl = parsedAuthorizationUrl.format()

    return authorizationUrl
  }

  registerDynamicsMethods({ server, cache, config, internals })

  server.method('idm.getCredentials', getCredentials)
  server.method('idm.getClaims', getClaims)
  server.method('idm.generateAuthenticationUrl', generateAuthenticationUrl)
  server.method('idm.logout', logout)
  server.method('idm.refreshToken', refreshToken)
  server.method('idm.generateFirstStageOutboundRedirectUrl', generateFirstStageOutboundRedirectUrl)
  server.method('idm.generateFinalOutboundRedirectUrl', generateFinalOutboundRedirectUrl)

  server.method('idm.getConfig', () => config)
  server.method('idm.getInternals', () => internals)
  server.method('idm.getCache', () => cache)

  debug('Done registering server methods')
}