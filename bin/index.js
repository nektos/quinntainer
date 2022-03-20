#! /usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require('yargs/helpers');
const ora = require('ora');
const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');
const GitUrlParse = require("git-url-parse");
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
  await upsertRoleStack(repoInfo.org, repoInfo.repo, oidcProvider);

  // Setup GH action 
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

yargs(hideBin(process.argv))
  .command('init', 'init the repo to run on containers', () => {}, doInit)
  .demandCommand()
  .strict()
  .showHelpOnFail(true)
  .help(true)
  .argv
