const graphV1Root = 'https://graph.microsoft.com/v1.0';
const graphBetaRoot = 'https://graph.microsoft.com/beta';
const graphResource = 'https://graph.microsoft.com';
const defaultMaxDeviceCount = 10;
const defaultLostModeMessage = 'Your device is currently locked and you will be contacted shortly.';
const defaultLostModePhoneNumber = '000-000-0000';

async function handleLostModeRequest(options) {
  const {
    body,
    request,
    context,
    correlationId,
    env = process.env,
    fetchImpl = fetch
  } = options;

  validateCaller(request, env);

  const dryRun = body?.dryRun !== false;
  const userPrincipalName = normalizeOptionalString(body?.userPrincipalName);
  const userId = normalizeOptionalString(body?.userId);
  const maxDeviceCount = normalizePositiveInteger(body?.maxDeviceCount, defaultMaxDeviceCount);
  const lostModePayload = getLostModePayload(env);

  if (!userPrincipalName && !userId) {
    return result(400, correlationId, {
      error: 'Provide either userPrincipalName or userId.'
    });
  }

  const token = await getManagedIdentityGraphToken({ env, fetchImpl });
  const user = await resolveUser({ userId, userPrincipalName, token, fetchImpl });
  const devices = await findAppleMobileDevicesForUser({
    userId: user.id,
    token,
    fetchImpl,
    context
  });
  const eligibleDevices = devices.filter((device) => !isPersonallyOwned(device));
  const skippedDevices = devices
    .filter(isPersonallyOwned)
    .map((device) => ({
      ...device,
      reason: 'Device is personally owned.'
    }));

  if (eligibleDevices.length > maxDeviceCount) {
    return result(409, correlationId, {
      dryRun,
      user: userSummary(user),
      matchedDeviceCount: devices.length,
      eligibleDeviceCount: eligibleDevices.length,
      skippedDeviceCount: skippedDevices.length,
      devices,
      eligibleDevices,
      skippedDevices,
      lostModeResults: [],
      error: `Eligible device count ${eligibleDevices.length} exceeds maxDeviceCount ${maxDeviceCount}. No lost mode commands were sent.`
    });
  }

  const lostModeResults = [];

  if (!dryRun) {
    for (const device of eligibleDevices) {
      const lostModeResult = await enableLostMode({
        managedDeviceId: device.id,
        token,
        payload: lostModePayload,
        fetchImpl
      });

      lostModeResults.push({
        id: device.id,
        deviceName: device.deviceName,
        status: lostModeResult.status,
        ok: lostModeResult.ok,
        error: lostModeResult.error
      });
    }
  }

  context.log(
    JSON.stringify({
      correlationId,
      user: user.userPrincipalName,
      matchedDeviceCount: devices.length,
      eligibleDeviceCount: eligibleDevices.length,
      skippedDeviceCount: skippedDevices.length,
      dryRun
    })
  );

  return result(200, correlationId, {
    dryRun,
    user: userSummary(user),
    lostModeMessage: lostModePayload,
    matchedDeviceCount: devices.length,
    eligibleDeviceCount: eligibleDevices.length,
    skippedDeviceCount: skippedDevices.length,
    devices,
    eligibleDevices,
    skippedDevices,
    lostModeResults
  });
}

function validateCaller(request, env) {
  const expectedSecret = env.OKTA_SHARED_SECRET;

  if (!expectedSecret) {
    return;
  }

  const providedSecret = request.headers.get('x-okta-shared-secret');

  if (!providedSecret || providedSecret !== expectedSecret) {
    const error = new Error('Unauthorized caller.');
    error.statusCode = 401;
    throw error;
  }
}

function getLostModePayload(env) {
  return {
    message: normalizeOptionalString(env.LOST_MODE_MESSAGE) || defaultLostModeMessage,
    phoneNumber: normalizeOptionalString(env.LOST_MODE_PHONE_NUMBER) || defaultLostModePhoneNumber,
    footer: normalizeOptionalString(env.LOST_MODE_FOOTER) || ''
  };
}

async function getManagedIdentityGraphToken({ env, fetchImpl }) {
  const identityEndpoint = env.IDENTITY_ENDPOINT;
  const identityHeader = env.IDENTITY_HEADER;

  if (!identityEndpoint || !identityHeader) {
    throw new Error('Managed identity endpoint is unavailable. Run this Function in Azure with managed identity enabled.');
  }

  const url = new URL(identityEndpoint);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', graphResource);

  const response = await fetchImpl(url, {
    headers: {
      'X-IDENTITY-HEADER': identityHeader
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(`Failed to obtain managed identity token. Status: ${response.status}`);
  }

  return payload.access_token;
}

async function resolveUser({ userId, userPrincipalName, token, fetchImpl }) {
  const userIdentifier = encodeURIComponent(userId || userPrincipalName);
  return getGraph(`${graphV1Root}/users/${userIdentifier}?$select=id,userPrincipalName,displayName`, token, fetchImpl);
}

async function findAppleMobileDevicesForUser({ userId, token, fetchImpl, context }) {
  const matchingDevices = [];
  const select = '$select=id,deviceName,managedDeviceName,operatingSystem,osVersion,deviceType,model,manufacturer,managementState,managedDeviceOwnerType,userPrincipalName,azureADDeviceId,serialNumber,lastSyncDateTime';
  let nextUrl = `${graphBetaRoot}/users/${encodeURIComponent(userId)}/managedDevices?${select}`;

  while (nextUrl) {
    const page = await getGraph(nextUrl, token, fetchImpl);
    const devices = Array.isArray(page.value) ? page.value : [];

    for (const device of devices) {
      if (isIphoneOrIpad(device)) {
        matchingDevices.push({
          id: device.id,
          deviceName: device.deviceName,
          managedDeviceName: device.managedDeviceName,
          operatingSystem: device.operatingSystem,
          osVersion: device.osVersion,
          deviceType: device.deviceType,
          model: device.model,
          manufacturer: device.manufacturer,
          managementState: device.managementState,
          managedDeviceOwnerType: device.managedDeviceOwnerType,
          enrolledUserPrincipalName: device.userPrincipalName,
          azureADDeviceId: device.azureADDeviceId,
          serialNumber: device.serialNumber,
          lastSyncDateTime: device.lastSyncDateTime
        });
      }
    }

    context.log(`Scanned ${devices.length} managed devices for target user from current page.`);
    nextUrl = page['@odata.nextLink'];
  }

  return matchingDevices;
}

function isIphoneOrIpad(device) {
  const operatingSystem = (device.operatingSystem || '').toLowerCase();
  const deviceType = (device.deviceType || '').toLowerCase();
  const model = (device.model || '').toLowerCase();

  const isAppleMobileOs = operatingSystem === 'ios' || operatingSystem === 'ipados';
  const typeMatches = deviceType === 'iphone' || deviceType === 'ipad';
  const modelMatches = model.includes('iphone') || model.includes('ipad');

  return isAppleMobileOs && (typeMatches || modelMatches);
}

function isPersonallyOwned(device) {
  const ownerType = (device.managedDeviceOwnerType || '').toLowerCase();
  return ownerType === 'personal' || ownerType === 'personallyowned';
}

async function enableLostMode({ managedDeviceId, token, payload, fetchImpl }) {
  const response = await fetchImpl(
    `${graphBetaRoot}/deviceManagement/managedDevices/${encodeURIComponent(managedDeviceId)}/enableLostMode`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  if (response.ok) {
    return {
      ok: true,
      status: response.status
    };
  }

  const text = await response.text();
  return {
    ok: false,
    status: response.status,
    error: text
  };
}

async function getGraph(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });

  if (response.ok) {
    return response.json();
  }

  const text = await response.text();
  const error = new Error(`Graph request failed. Status: ${response.status}. ${text}`);
  error.statusCode = response.status;
  throw error;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function userSummary(user) {
  return {
    id: user.id,
    userPrincipalName: user.userPrincipalName,
    displayName: user.displayName
  };
}

function result(status, correlationId, body) {
  return {
    status,
    body: {
      correlationId,
      ...body
    }
  };
}

module.exports = {
  handleLostModeRequest,
  validateCaller,
  getLostModePayload,
  getManagedIdentityGraphToken,
  resolveUser,
  findAppleMobileDevicesForUser,
  isIphoneOrIpad,
  isPersonallyOwned,
  enableLostMode,
  normalizeOptionalString
};
