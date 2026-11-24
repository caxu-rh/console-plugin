import { execFileSync } from 'child_process';
import { test, expect } from '@playwright/test';
import { checkErrors } from '../support';

const PLUGIN_NAME = 'partner-labs-console-plugin';
// Defined in openshift/release ci-operator config as CYPRESS_PLUGIN_TEMPLATE_PULL_SPEC
const PLUGIN_TEMPLATE_PULL_SPEC =
  process.env.PLUGIN_TEMPLATE_PULL_SPEC ?? process.env.CYPRESS_PLUGIN_TEMPLATE_PULL_SPEC;
const PLUGIN_IMAGE_PULL_SECRET = process.env.PLUGIN_IMAGE_PULL_SECRET;
const SKIP_PATCH_JOB = process.env.PLUGIN_SKIP_PATCH_JOB === 'true';

let chartInstalled = false;
let helmPath = 'helm';

function runCommand(command: string, args: string[] = []) {
  return execFileSync(command, args, { timeout: 1_800_000, encoding: 'utf-8' });
}

// Use an existing Helm 3 or Helm 4 installation. Fall back to the script used by
// the OpenShift CI job when Helm is not on PATH.
function resolveHelm(): string {
  try {
    const version = runCommand('helm', ['version', '--short']).trim();
    if (/^v[34]\./.test(version)) {
      return 'helm';
    }
  } catch {
    // Fall through to the installer below.
  }
  console.log('No supported Helm installation was found, downloading it to /tmp');
  runCommand('./install_helm.sh');
  return '/tmp/helm';
}

function installHelmChart(helm: string) {
  if (!PLUGIN_TEMPLATE_PULL_SPEC) {
    throw new Error('Set PLUGIN_TEMPLATE_PULL_SPEC to the plugin image before running E2E tests.');
  }

  const pullSecretArgs = PLUGIN_IMAGE_PULL_SECRET
    ? ['--set', `plugin.imagePullSecrets[0].name=${PLUGIN_IMAGE_PULL_SECRET}`]
    : [];
  // OKD uses a dummy cluster pull secret, so the chart's patcher image from
  // registry.redhat.io cannot be pulled. Patch the console operator directly.
  const patchArgs = SKIP_PATCH_JOB ? ['--set', 'plugin.jobs.patchConsoles.enabled=false'] : [];
  const result = runCommand(helm, [
    'upgrade',
    '-i',
    PLUGIN_NAME,
    'charts/partner-labs-console-plugin',
    '-n',
    PLUGIN_NAME,
    '--create-namespace',
    '--timeout',
    '10m',
    '--set',
    `plugin.image=${PLUGIN_TEMPLATE_PULL_SPEC}`,
    ...patchArgs,
    ...pullSecretArgs,
  ]);
  chartInstalled = true;
  console.log('Helm install:', result);

  runCommand('oc', [
    'rollout',
    'status',
    '-n',
    PLUGIN_NAME,
    `deploy/${PLUGIN_NAME}`,
    '-w',
    '--timeout=600s',
  ]);

  if (SKIP_PATCH_JOB) {
    const generation = consoleDeploymentGeneration();
    runCommand('oc', [
      'patch',
      'consoles.operator.openshift.io',
      'cluster',
      '--type=merge',
      '-p',
      `{"spec":{"plugins":["${PLUGIN_NAME}"]}}`,
    ]);
    // Wait for the console operator to start a new console rollout. Without
    // this, the rollout check below can pass against the old console.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (consoleDeploymentGeneration() > generation) {
        break;
      }
      runCommand('sleep', ['5']);
    }
  }

  runCommand('oc', [
    'rollout',
    'status',
    '-w',
    'deploy/console',
    '-n',
    'openshift-console',
    '--timeout=600s',
  ]);
}

function deleteHelmChart(helm: string) {
  const result = runCommand(helm, ['uninstall', PLUGIN_NAME, '-n', PLUGIN_NAME]);
  console.log('Helm uninstall:', result);
  runCommand('oc', ['delete', 'namespaces', PLUGIN_NAME]);
}

function consoleDeploymentGeneration(): number {
  return Number(
    runCommand('oc', [
      'get',
      'deployment/console',
      '-n',
      'openshift-console',
      '-o',
      'jsonpath={.metadata.generation}',
    ]).trim(),
  );
}

test.describe('Console plugin cards', () => {
  test.beforeAll(() => {
    test.setTimeout(1_800_000);
    helmPath = resolveHelm();
    installHelmChart(helmPath);
  });

  test.afterEach(async ({ page }) => {
    await checkErrors(page);
  });

  test.afterAll(() => {
    test.setTimeout(600_000);
    if (!chartInstalled) {
      return;
    }
    deleteHelmChart(helmPath);
  });

  test('opens the custom page card', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-page').click();
    await expect(page).toHaveURL(/\/partner-labs-example$/);
    await expect(page.getByRole('heading', { name: 'Custom Page' })).toBeVisible();
    await expect(page.getByText('Console SDK examples')).toBeVisible();
    await expect(page.getByTestId('copy-example-command')).toBeVisible();
  });

  test('shows the project selector on the demos page', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await expect(page.locator('[data-test-id="namespace-bar-dropdown"]')).toBeVisible();
    await expect(page.getByTestId('card-pipeline')).toBeVisible();
  });

  test('opens the VM creation quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-create-vm-web-console').click();
    await expect(
      page.getByRole('heading', { name: 'Create a VM from the web console', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Open VirtualMachines and select a project', { exact: true }),
    ).toBeVisible();
  });

  test('opens the OpenShift Virtualization installation quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-install-configure-ocpv-operator').click();
    await expect(
      page.getByRole('heading', {
        name: 'Install and configure OpenShift Virtualization',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('Open OperatorHub', { exact: true })).toBeVisible();
  });

  test('opens the Windows golden images quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-windows-golden-images').click();
    await expect(
      page.getByRole('heading', { name: 'Create Windows golden images', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Prepare a dedicated project', { exact: true })).toBeVisible();
  });

  test('opens the VM ingress routes quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-vm-ingress-routes').click();
    await expect(
      page.getByRole('heading', { name: 'Expose a VM with an HTTPS Route', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Create a dedicated test project', { exact: true })).toBeVisible();
  });

  test('opens the VM lifecycle states quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-vm-lifecycle-states').click();
    await expect(
      page.getByRole('heading', { name: 'Understanding VM lifecycle states', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Understand VM and VMI resources', { exact: true })).toBeVisible();
  });

  test('opens the Windows VirtIO drivers quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-windows-vm-virtio-drivers').click();
    await expect(
      page.getByRole('heading', { name: 'Install Windows with VirtIO drivers', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Prepare a project and installation media', { exact: true }),
    ).toBeVisible();
  });

  test('opens the Windows SSH access quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-ssh-access-windows-vms').click();
    await expect(
      page.getByRole('heading', { name: 'Connect to a Windows VM via SSH', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Declare port 22 on the VM interface', { exact: true }),
    ).toBeVisible();
  });

  test('opens the VM network policies quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-network-policies-vms').click();
    await expect(
      page.getByRole('heading', { name: 'VM Cookbook: Network Policies for VMs', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Create the demo project and clients', { exact: true }),
    ).toBeVisible();
  });

  test('opens the static IP configuration quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-static-ip-configuration').click();
    await expect(
      page.getByRole('heading', { name: 'VM Cookbook: Static IP Configuration', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Create a dedicated test project', { exact: true })).toBeVisible();
  });

  test('opens the LVM Storage Operator quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-install-lvm-storage-operator').click();
    await expect(
      page.getByRole('heading', {
        name: 'Install the LVM Storage Operator',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('Identify a spare disk', { exact: true })).toBeVisible();
  });

  test('opens the CLI YAML VM quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-create-vm-cli-yaml').click();
    await expect(
      page.getByRole('heading', { name: 'Create a VM with CLI YAML', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Create a project and verify the boot source', { exact: true }),
    ).toBeVisible();
  });

  test('opens the virtctl basics quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-virtctl-basics').click();
    await expect(
      page.getByRole('heading', { name: 'Using virtctl for VM management', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Install virtctl', { exact: true })).toBeVisible();
  });

  test('opens the multi-disk configuration quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-multi-disk-configuration').click();
    await expect(
      page.getByRole('heading', { name: 'Configure multiple VM disks', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Choose the StorageClass and create a project', { exact: true }),
    ).toBeVisible();
  });

  test('opens the custom VM templates quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-vm-templates').click();
    await expect(
      page.getByRole('heading', { name: 'Create custom VM templates', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Inspect a supplied VM template', { exact: true })).toBeVisible();
  });

  test('opens the Cloud-init Fundamentals quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-cloud-init-fundamentals').click();
    await expect(
      page.getByRole('heading', { name: 'Cloud-init Fundamentals', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Check the Fedora boot source')).toBeVisible();
  });

  test('opens the VM monitoring and metrics quick start', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-vm-monitoring-metrics').click();
    await expect(
      page.getByRole('heading', { name: 'Monitor VM performance and metrics', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Create the monitoring VM', { exact: true })).toBeVisible();
  });

  test('opens the VM export and import walkthrough', async ({ page }) => {
    await page.goto('/partner-labs-demos');
    await page.getByTestId('card-action-vm-export-import').click();
    await expect(page).toHaveURL((url) => url.pathname === '/partner-labs-demos');
    await expect(
      page.getByRole('heading', {
        name: 'Exporting and Importing VMs for Cross-Cluster Mobility',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'OpenShift Virtualization cookbook', exact: true }),
    ).toHaveAttribute(
      'href',
      'https://redhatquickcourses.github.io/ocp-virt-cookbook/ocp-virt-cookbook/1/vm-lifecycle/vm-export-import.html',
    );
    await expect(
      page.getByText('Prepare the source and target projects', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Export the disk to a container registry', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Import the disk on the target cluster', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Download disks and manifests for offline use (optional CLI)', {
        exact: true,
      }),
    ).toBeVisible();
  });
});
