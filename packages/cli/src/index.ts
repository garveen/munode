#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command();

program
  .name('munode')
  .description('MuNode CLI')
  .version('0.1.0');

program
  .command('generate:cert')
  .description('Generate certificates')
  .action(() => {
    console.log('Generating certificates...');
    // TODO: implement
  });

program.parse();