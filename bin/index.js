#! /usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require('yargs/helpers');
const ora = require('ora');
const git = require('isomorphic-git');
const Mustache = require('mustache');
const fs = require('fs');
const http = require('isomorphic-git/http/node');
const path = require('path');
const GitUrlParse = require("git-url-parse");
const Diff = require('diff');
require('colors');
const inquirer = require('inquirer')
const { 
  CloudFormationClient, 
  CreateStackCommand,
  UpdateStackCommand,
  DescribeStacksCommand,
  DeleteStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  waitUntilStackDeleteComplete,
 } = require("@aws-sdk/client-cloudformation");


const doInit = async (argv) => {
  const repoInfo = await getRepoInfo();
  const providerStack = await upsertProviderStack();
  const oidcProvider = providerStack.Outputs
    .filter(o => o.OutputKey === 'OidcProvider')
    .map(o => o.OutputValue)[0];

  const roleStack = await upsertRoleStack(repoInfo.org, repoInfo.repo, oidcProvider);
  const role = roleStack.Outputs
    .filter(o => o.OutputKey === 'Role')
    .map(o => o.OutputValue)[0];

  const region = roleStack.StackId.split(':')[3];

  return setupWorkflow({
    region, 
    role, 
    branch: repoInfo.branch,
    root: repoInfo.root,
  });
};

const getRepoInfo = async () => {
  const gitroot = await git.findRoot({fs, filepath: process.cwd()});
  const remotes = await git.listRemotes({fs, dir: gitroot});
  const remoteUrl = GitUrlParse(remotes.filter(r => r.remote == 'origin').map(r => r.url)[0]);
  return {
    org: remoteUrl.organization,
    repo: remoteUrl.name,
    branch: await git.currentBranch({fs, dir: gitroot, fullname: false}),
    root: gitroot,
  };
};

const upsertProviderStack = async () => {
  return upsertStack({
    stackName: 'quinntainer-common',
    templateName: 'cfn-common.yaml',
    creationConfirmation: 'OK to create a new IAM OIDC Provider for GitHub Actions?',
  });
};
const upsertRoleStack = async (org, repo, oidcProvider) => {
  const stackParameters = [
    {ParameterKey: 'GitHubOrg', ParameterValue: org},
    {ParameterKey: 'RepositoryName', ParameterValue: repo},
    {ParameterKey: 'OidcProvider', ParameterValue: oidcProvider},
  ];
  return upsertStack({
    stackName: `quinntainer-role-${org}-${repo}`,
    templateName: 'cfn-role.yaml',
    capabilities: ["CAPABILITY_NAMED_IAM"],
    stackParameters,
    creationConfirmation: 'OK to create a new IAM role for GitHub Actions to assume?',
  });
};

const upsertStack = async (params) => {
  const { stackName, templateName, stackParameters, capabilities, creationConfirmation } = params;
  const client = new CloudFormationClient();
  let exists = false;
  try {
    const resp = await client.send(new DescribeStacksCommand({
      StackName: stackName,
    }));
    exists = true;
    if(resp.Stacks[0].StackStatus === 'ROLLBACK_COMPLETE') {
      const spinner = ora(`Cleaning up failed stack: ${stackName}`).start();
      await client.send(new DeleteStackCommand({ StackName: stackName }));
      await waitUntilStackDeleteComplete({client}, {
        StackName: stackName,
      });
      spinner.stop();
      exists = false;
    }
  } catch (e) {
    if(e.message !== `Stack with id ${stackName} does not exist`) {
      throw e;
    }
  }
  const template = fs.readFileSync(path.resolve(__dirname, `../${templateName}`));
  if(exists) {
    const spinner = ora(`Updating stack: ${stackName}`).start();
    try {
      const resp = await client.send(new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: template,
        Parameters: stackParameters,
        Capabilities: capabilities,
      }));
      await waitUntilStackUpdateComplete({client}, {
        StackName: stackName,
      });
    } catch (e) {
      if(e.message !== `No updates are to be performed.`) {
        throw e;
      }
    } finally {
      spinner.stop();
    }
  } else {
    if(creationConfirmation) {
      const answers = await inquirer.prompt([{
        type: "confirm",
        name: "approve",
        message: creationConfirmation,
        default: true,
      }]);
      if(answers.approve !== true) {
        throw new Error("Exiting");
      }
    }
    const spinner = ora(`Creating stack: ${stackName}`).start();
    await client.send(new CreateStackCommand({
      StackName: stackName,
      TemplateBody: template,
      Parameters: stackParameters,
      Parameters: stackParameters,
      Capabilities: capabilities,
    }));
    await waitUntilStackCreateComplete({client}, {
      StackName: stackName,
    });
    spinner.stop();
  }
  const resp = await client.send(new DescribeStacksCommand({
    StackName: stackName,
  }));
  return resp.Stacks[0]
};

const setupWorkflow = async (config) => {
    const answers = await inquirer.prompt([{
      type: "number",
      name: "port",
      message: "What port does your container expose?",
      default: 8080,
    }]);
    config.port = answers.port;
    const template = fs.readFileSync(path.resolve(__dirname, '../gha-deploy.yaml')).toString('utf8');
    const newWorkflow = Mustache.render(template, config);

    const workflowRelPath = '.github/workflows/quinntainer-deploy.yaml';
    const workflowPath = path.resolve(config.root, workflowRelPath);

    if(fs.existsSync(workflowPath)) {
      const existingWorkflow = fs.readFileSync(workflowPath).toString('utf8');
      const diff = Diff.diffLines(existingWorkflow, newWorkflow);
      if(diff.filter(part => part.added || part.removed).length) {
        diff.forEach((part) => {
          // green for additions, red for deletions
          // grey for common parts
          const color = part.added ? 'green' :
            part.removed ? 'red' : 'grey';
          process.stderr.write(part.value[color]);
        });
        const answers = await inquirer.prompt([{
          type: "confirm",
          name: "approve",
          message: `OK to overwrite ${workflowPath} with these changes?`,
          default: true,
        }]);
        if(answers.approve !== true) {
          throw new Error("Exiting");
        }
      } else {
        // no changes
        return;
      }
    }

    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, newWorkflow);
    console.log("Changes to workflow file have been made. You now need to commit and push these to take effect.")
};

yargs(hideBin(process.argv))
  .command('init', 'init the repo to run on containers', () => {}, doInit)
  .demandCommand()
  .strict()
  .showHelpOnFail(true)
  .help(true)
  .argv
