# Intune iOS Lost Mode Function

This project is a separate HTTP-triggered Azure Function intended to be called by Okta Workflows.

Its job is:

1. Receive a target user from Okta.
2. Resolve that user in Microsoft Graph.
3. Retrieve Intune managed devices associated with that user.
4. Filter those devices to iPhone and iPad.
5. Split matching devices into eligible company-owned devices and skipped personally owned devices.
6. Return the matching device list.
7. Enable Intune Lost Mode only for eligible company-owned devices when the request explicitly sets `dryRun` to `false`.

The Function uses the Azure Function App's managed identity. It does not store Microsoft Graph credentials in code or in Okta.

## Important Platform Notes

Microsoft documents Lost Mode as supported for iOS/iPadOS devices in supervised mode. The Microsoft Graph `enableLostMode` action is currently documented under Microsoft Graph `/beta`, so this Function uses `/beta` for the managed device lookup and Lost Mode action.

If a matched device is not eligible for Lost Mode, Graph can return an error for that specific device. The Function returns that result in `lostModeResults`.

## Project Files

```text
intune-ios-lost-mode-function/
  .funcignore
  .gitignore
  host.json
  local.settings.sample.json
  package.json
  README.md
  scripts/
    grant-graph-app-roles.ps1
    new-function-app.ps1
    publish-function.ps1
  src/
    index.js
    functions/
      enableLostModeForUserDevices.js
    lib/
      iosLostModeService.js
  tests/
    iosLostModeService.test.js
```

## Endpoint

Method:

```text
POST
```

Route:

```text
/api/enableLostModeForUserDevices
```

Authentication level:

```text
function
```

External callers need the Azure Function URL with the `code=` function key.

## Request Body

Dry-run example:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": true
}
```

You can also pass `userId` instead of `userPrincipalName`.

`dryRun` defaults to `true`.

The Function sends Lost Mode commands only when:

```json
{
  "dryRun": false
}
```

If the target user exists but has no Intune managed devices associated with the user account, the Function returns `200 OK` with `matchedDeviceCount: 0`, `eligibleDeviceCount: 0`, `skippedDeviceCount: 0`, `devices: []`, `eligibleDevices: []`, `skippedDevices: []`, and `lostModeResults: []`.

## Optional Shared Secret

If `OKTA_SHARED_SECRET` is configured as an app setting, callers must include:

```text
x-okta-shared-secret: <secret value>
```

This is an extra guardrail on top of the Azure Function key.

## Response

Dry-run response shape:

```json
{
  "correlationId": "generated-request-id",
  "dryRun": true,
  "user": {
    "id": "user-object-id",
    "userPrincipalName": "person@example.com",
    "displayName": "Person Name"
  },
  "matchedDeviceCount": 1,
  "eligibleDeviceCount": 1,
  "skippedDeviceCount": 0,
  "devices": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "IPHONE-01",
      "managedDeviceName": "IPHONE-01",
      "operatingSystem": "iOS",
      "osVersion": "17.5",
      "deviceType": "iPhone",
      "model": "iPhone 15",
      "manufacturer": "Apple",
      "managementState": "managed",
      "managedDeviceOwnerType": "company",
      "enrolledUserPrincipalName": "person@example.com",
      "azureADDeviceId": "entra-device-id",
      "serialNumber": "serial-number",
      "lastSyncDateTime": "2026-05-29T00:00:00Z"
    }
  ],
  "eligibleDevices": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "IPHONE-01"
    }
  ],
  "skippedDevices": [],
  "lostModeResults": []
}
```

Live response shape:

```json
{
  "correlationId": "generated-request-id",
  "dryRun": false,
  "matchedDeviceCount": 1,
  "eligibleDeviceCount": 1,
  "skippedDeviceCount": 0,
  "devices": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "IPHONE-01"
    }
  ],
  "eligibleDevices": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "IPHONE-01"
    }
  ],
  "skippedDevices": [],
  "lostModeResults": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "IPHONE-01",
      "status": 204,
      "ok": true
    }
  ]
}
```

## Safety Behavior

The Function will not enable Lost Mode when:

- The request omits both `userPrincipalName` and `userId`.
- The shared secret is configured and the caller does not provide the matching header.
- The target user cannot be resolved in Microsoft Graph.
- No matching iPhone or iPad Intune devices are found.
- `dryRun` is omitted or set to `true`.
- The matched device count exceeds `maxDeviceCount`.

Personally owned iPhones and iPads are returned in `skippedDevices` and are never sent Lost Mode commands.

`maxDeviceCount` defaults to `10`. Override it in the request if needed:

```json
{
  "maxDeviceCount": 25
}
```

## Managed Identity Permissions

Enable a system-assigned managed identity on the Function App and grant these Microsoft Graph application permissions with admin consent:

- `User.Read.All`
- `DeviceManagementManagedDevices.Read.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`

After the Function App exists, an Entra admin can assign the required Microsoft Graph application roles with:

```powershell
.\scripts\grant-graph-app-roles.ps1 `
  -ResourceGroupName '<resource-group>' `
  -FunctionAppName '<function-app-name>'
```

## Graph Calls Used

Resolve the user:

```text
GET https://graph.microsoft.com/v1.0/users/{userPrincipalName-or-userId}?$select=id,userPrincipalName,displayName
```

List devices associated with the user:

```text
GET https://graph.microsoft.com/beta/users/{userId}/managedDevices?$select=...
```

Enable Lost Mode:

```text
POST https://graph.microsoft.com/beta/deviceManagement/managedDevices/{managedDeviceId}/enableLostMode
```

Lost Mode body sent to Graph:

```json
{
  "message": "Your device is currently locked and you will be contacted shortly.",
  "phoneNumber": "000-000-0000",
  "footer": ""
}
```

The Okta request does not need to send a message, phone number, or footer. The Function sends the default values above. You can override them with Azure app settings:

```text
LOST_MODE_MESSAGE
LOST_MODE_PHONE_NUMBER
LOST_MODE_FOOTER
```

## Local Validation

Run syntax checks:

```powershell
npm run check
```

Run mocked tests:

```powershell
npm test
```

The mocked tests do not call Azure, Microsoft Graph, Intune, or Okta.

## Azure Portal Build Steps

1. Create a new private GitHub repo or branch for this folder.
2. Push the contents of `intune-ios-lost-mode-function`.
3. In Azure Portal, create a new Function App:
   - Hosting: Flex Consumption if available.
   - Runtime: Node.js.
   - Version: 22 or 20.
   - OS: Linux.
   - Monitoring: Application Insights enabled.
4. Turn on system-assigned managed identity:
   - Function App > Identity > System assigned > On > Save.
5. Add app setting:
   - `OKTA_SHARED_SECRET = <long random value>`
   - Optional: `LOST_MODE_MESSAGE`
   - Optional: `LOST_MODE_PHONE_NUMBER`
   - Optional: `LOST_MODE_FOOTER`
6. Use Deployment Center to connect the Function App to the GitHub repo/branch.
7. Wait for deployment success.
8. Run `scripts/grant-graph-app-roles.ps1` in Azure Cloud Shell PowerShell.
9. Restart the Function App.
10. Test in Azure with `dryRun: true`.

## Azure Test/Run Body

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": true
}
```

Headers:

```text
Content-Type: application/json
x-okta-shared-secret: <secret value>
```

Leave query parameters empty in Azure Portal Test/Run.

## Okta Workflow Body

Start with dry run:

```json
{
  "userPrincipalName": "{{user.email}}",
  "dryRun": true
}
```

After validating the returned device list, switch to:

```json
{
  "userPrincipalName": "{{user.email}}",
  "dryRun": false
}
```

That is the point where Lost Mode commands are sent.
