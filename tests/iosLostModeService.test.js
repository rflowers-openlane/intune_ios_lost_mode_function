const test = require('node:test');
const assert = require('node:assert/strict');
const { handleLostModeRequest, isIphoneOrIpad, isPersonallyOwned, getLostModePayload } = require('../src/lib/iosLostModeService');

const targetUserId = '11111111-1111-1111-1111-111111111111';

test('returns 400 when no user identifier is provided', async () => {
  const calls = [];
  const result = await handleLostModeRequest({
    body: {},
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error('fetch should not be called');
    }
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Provide either userPrincipalName or userId.');
  assert.equal(calls.length, 0);
});

test('rejects requests when the optional shared secret does not match', async () => {
  await assert.rejects(
    handleLostModeRequest({
      body: {
        userPrincipalName: 'person@example.com'
      },
      request: requestWithHeaders({
        'x-okta-shared-secret': 'wrong-secret'
      }),
      context: testContext(),
      correlationId: 'test-correlation-id',
      env: testEnv({
        OKTA_SHARED_SECRET: 'expected-secret'
      }),
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      }
    }),
    /Unauthorized caller/
  );
});

test('dry-run returns iPhone and iPad devices without enabling lost mode', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleLostModeRequest({
    body: {
      userPrincipalName: 'person@example.com'
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, true);
  assert.equal(result.body.matchedDeviceCount, 3);
  assert.equal(result.body.eligibleDeviceCount, 2);
  assert.equal(result.body.skippedDeviceCount, 1);
  assert.deepEqual(result.body.devices.map((device) => device.id), ['iphone-1', 'ipad-1', 'personal-iphone-1']);
  assert.deepEqual(result.body.eligibleDevices.map((device) => device.id), ['iphone-1', 'ipad-1']);
  assert.deepEqual(result.body.skippedDevices.map((device) => device.id), ['personal-iphone-1']);
  assert.deepEqual(result.body.lostModeMessage, {
    message: 'Your device is currently locked and you will be contacted shortly.',
    phoneNumber: '000-000-0000',
    footer: ''
  });
  assert.deepEqual(result.body.lostModeResults, []);
  assert.equal(calls.some((call) => call.url.endsWith('/enableLostMode')), false);
});

test('live request enables lost mode only for eligible company-owned iPhone and iPad devices', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleLostModeRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  const lostModeCalls = calls.filter((call) => call.url.endsWith('/enableLostMode'));

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, false);
  assert.equal(result.body.matchedDeviceCount, 3);
  assert.equal(result.body.eligibleDeviceCount, 2);
  assert.equal(result.body.skippedDeviceCount, 1);
  assert.equal(lostModeCalls.length, 2);
  assert.match(lostModeCalls[0].url, /managedDevices\/iphone-1\/enableLostMode$/);
  assert.match(lostModeCalls[1].url, /managedDevices\/ipad-1\/enableLostMode$/);
  assert.equal(lostModeCalls.some((call) => call.url.includes('personal-iphone-1')), false);
  assert.deepEqual(JSON.parse(lostModeCalls[0].init.body), {
    message: 'Your device is currently locked and you will be contacted shortly.',
    phoneNumber: '000-000-0000',
    footer: ''
  });
  assert.equal(result.body.lostModeResults.every((entry) => entry.ok), true);
});

test('blocks live action when matched devices exceed maxDeviceCount', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleLostModeRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false,
      maxDeviceCount: 1
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.matchedDeviceCount, 3);
  assert.equal(result.body.eligibleDeviceCount, 2);
  assert.equal(calls.some((call) => call.url.endsWith('/enableLostMode')), false);
});

test('isIphoneOrIpad requires Apple mobile OS plus iPhone or iPad type/model', () => {
  assert.equal(isIphoneOrIpad({ operatingSystem: 'iOS', deviceType: 'iPhone' }), true);
  assert.equal(isIphoneOrIpad({ operatingSystem: 'iPadOS', model: 'iPad Pro' }), true);
  assert.equal(isIphoneOrIpad({ operatingSystem: 'iOS', deviceType: 'iPod' }), false);
  assert.equal(isIphoneOrIpad({ operatingSystem: 'macOS', model: 'iPad' }), false);
});

test('isPersonallyOwned detects personal ownership values', () => {
  assert.equal(isPersonallyOwned({ managedDeviceOwnerType: 'personal' }), true);
  assert.equal(isPersonallyOwned({ managedDeviceOwnerType: 'personallyOwned' }), true);
  assert.equal(isPersonallyOwned({ managedDeviceOwnerType: 'company' }), false);
  assert.equal(isPersonallyOwned({}), false);
});

test('getLostModePayload uses app setting overrides when provided', () => {
  assert.deepEqual(getLostModePayload({
    LOST_MODE_MESSAGE: 'Custom message',
    LOST_MODE_PHONE_NUMBER: '555-0100',
    LOST_MODE_FOOTER: 'IT'
  }), {
    message: 'Custom message',
    phoneNumber: '555-0100',
    footer: 'IT'
  });
});

function buildGraphFetchMock(calls) {
  return async (input, init = {}) => {
    const url = input.toString();
    const method = init.method || 'GET';
    calls.push({ url, method, init });

    if (url.startsWith('http://identity.local/token')) {
      return jsonResponse(200, {
        access_token: 'managed-identity-token'
      });
    }

    if (url.includes('/users/person%40example.com')) {
      return jsonResponse(200, {
        id: targetUserId,
        userPrincipalName: 'person@example.com',
        displayName: 'Example Person'
      });
    }

    if (url.includes(`/users/${targetUserId}/managedDevices?`)) {
      return jsonResponse(200, {
        value: [
          {
            id: 'iphone-1',
            deviceName: 'IPHONE-01',
            managedDeviceName: 'IPHONE-01',
            operatingSystem: 'iOS',
            osVersion: '17.5',
            deviceType: 'iPhone',
            model: 'iPhone 15',
            manufacturer: 'Apple',
            managementState: 'managed',
            managedDeviceOwnerType: 'company',
            userPrincipalName: 'person@example.com',
            azureADDeviceId: 'azure-iphone-1',
            serialNumber: 'iphone-serial-1',
            lastSyncDateTime: '2026-05-29T00:00:00Z'
          },
          {
            id: 'ipad-1',
            deviceName: 'IPAD-01',
            managedDeviceName: 'IPAD-01',
            operatingSystem: 'iPadOS',
            osVersion: '17.5',
            deviceType: 'iPad',
            model: 'iPad Pro',
            manufacturer: 'Apple',
            managementState: 'managed',
            managedDeviceOwnerType: 'company',
            userPrincipalName: 'person@example.com',
            azureADDeviceId: 'azure-ipad-1',
            serialNumber: 'ipad-serial-1',
            lastSyncDateTime: '2026-05-29T00:00:00Z'
          },
          {
            id: 'personal-iphone-1',
            deviceName: 'PERSONAL-IPHONE-01',
            managedDeviceName: 'PERSONAL-IPHONE-01',
            operatingSystem: 'iOS',
            osVersion: '17.5',
            deviceType: 'iPhone',
            model: 'iPhone 14',
            manufacturer: 'Apple',
            managementState: 'managed',
            managedDeviceOwnerType: 'personal',
            userPrincipalName: 'person@example.com',
            azureADDeviceId: 'azure-personal-iphone-1',
            serialNumber: 'personal-iphone-serial-1',
            lastSyncDateTime: '2026-05-29T00:00:00Z'
          },
          {
            id: 'windows-1',
            deviceName: 'WINDOWS-01',
            operatingSystem: 'Windows',
            deviceType: 'desktop',
            model: 'Laptop'
          }
        ]
      });
    }

    if (method === 'POST' && url.endsWith('/managedDevices/iphone-1/enableLostMode')) {
      return textResponse(204, '');
    }

    if (method === 'POST' && url.endsWith('/managedDevices/ipad-1/enableLostMode')) {
      return textResponse(204, '');
    }

    return textResponse(404, `Unexpected mock URL: ${url}`);
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body || '{}'),
    text: async () => body
  };
}

function requestWithHeaders(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    headers: {
      get: (name) => normalized[name.toLowerCase()] || null
    }
  };
}

function testContext() {
  return {
    log: () => {},
    error: () => {}
  };
}

function testEnv(overrides = {}) {
  return {
    IDENTITY_ENDPOINT: 'http://identity.local/token',
    IDENTITY_HEADER: 'identity-header',
    ...overrides
  };
}
