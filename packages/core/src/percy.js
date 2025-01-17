import PercyClient from '@percy/client';
import PercyConfig from '@percy/config';
import logger from '@percy/logger';
import Queue from './queue';
import Browser from './browser';
import createPercyServer from './server';
import { getSnapshotConfig } from './config';

import {
  createRootResource,
  createLogResource,
  createPercyCSSResource,
  hostnameMatches,
  injectPercyCSS
} from './utils';

// A Percy instance will create a new build when started, handle snapshot
// creation, asset discovery, and resource uploads, and will finalize the build
// when stopped. Snapshots are processed concurrently and the build is not
// finalized until all snapshots have been handled.
export default class Percy {
  log = logger('core');
  readyState = null;

  #cache = new Map();
  #uploads = new Queue();
  #snapshots = new Queue();

  // Static shortcut to create and start an instance in one call
  static async start(options) {
    let instance = new this(options);
    await instance.start();
    return instance;
  }

  constructor({
    // initial log level
    loglevel,
    // do not eagerly upload snapshots
    deferUploads,
    // run without uploading anything
    skipUploads,
    // configuration filepath
    config,
    // provided to @percy/client
    token,
    clientInfo = '',
    environmentInfo = '',
    // snapshot server options
    server = true,
    port = 5338,
    // options such as `snapshot` and `discovery` that are valid Percy config
    // options which will become accessible via the `.config` property
    ...options
  } = {}) {
    if (loglevel) this.loglevel(loglevel);
    this.deferUploads = skipUploads || deferUploads;
    this.skipUploads = skipUploads;

    this.config = PercyConfig.load({
      overrides: options,
      path: config
    });

    let { concurrency } = this.config.discovery;
    if (concurrency) this.#snapshots.concurrency = concurrency;
    if (this.deferUploads) this.#uploads.stop();

    this.client = new PercyClient({
      token,
      clientInfo,
      environmentInfo
    });

    this.browser = new Browser({
      ...this.config.discovery.launchOptions,
      cookies: this.config.discovery.cookies
    });

    if (server) {
      this.server = createPercyServer(this);
      this.port = port;
    }
  }

  // Shortcut for controlling the global logger's log level.
  loglevel(level) {
    return logger.loglevel(level);
  }

  // Snapshot server API address
  address() {
    return `http://localhost:${this.port}`;
  }

  // Resolves once snapshot and upload queues are idle
  async idle() {
    await this.#snapshots.idle();
    await this.#uploads.idle();
  }

  // Waits for snapshot idle and flushes the upload queue
  async dispatch() {
    await this.#snapshots.idle();
    if (!this.skipUploads) await this.#uploads.flush();
  }

  // Immediately stops all queues, preventing any more tasks from running
  close() {
    this.#snapshots.close(true);
    this.#uploads.close(true);
  }

  // Starts a local API server, a browser process, and queues creating a new Percy build which will run
  // at a later time when uploads are deferred, or run immediately when not deferred.
  async start() {
    // already starting or started
    if (this.readyState != null) return;
    this.readyState = 0;

    // create a percy build as the first immediately queued task
    let buildTask = this.#uploads.push('build/create', () => {
      // pause other queued tasks until after the build is created
      this.#uploads.stop();

      return this.client.createBuild()
        .then(({ data: { id, attributes } }) => {
          this.build = { id };
          this.build.number = attributes['build-number'];
          this.build.url = attributes['web-url'];
          this.#uploads.run();
        });
    }, 0);

    // handle deferred build errors
    if (this.deferUploads) {
      buildTask.catch(err => {
        this.log.error('Failed to create build');
        this.log.error(err);
        this.close();
      });
    }

    try {
      // when not deferred, wait until the build is created first
      if (!this.deferUploads) await buildTask;
      // launch the discovery browser
      await this.browser.launch(this.config.discovery.launchOptions);
      // if there is a server, start listening
      await this.server?.listen(this.port);

      // mark this process as running
      this.log.info('Percy has started!');
      this.readyState = 1;
    } catch (error) {
      // on error, close any running server and browser
      await this.server?.close();
      await this.browser.close();
      this.readyState = 3;

      // throw an easier-to-understand error when the port is taken
      if (error.code === 'EADDRINUSE') {
        throw new Error('Percy is already running or the port is in use');
      } else {
        throw error;
      }
    }
  }

  // Stops the local API server and browser once snapshots have completed and finalizes the Percy
  // build. Does nothing if not running. When `force` is true, any queued tasks are cleared.
  async stop(force) {
    // not started or already stopped
    if (!this.readyState || this.readyState > 2) return;

    // close queues asap
    if (force) this.close();

    // already stopping
    if (this.readyState === 2) return;
    this.readyState = 2;

    // log when force stopping
    let meta = { build: this.build };
    if (force) this.log.info('Stopping percy...', meta);

    // close the snapshot queue and wait for it to empty
    if (this.#snapshots.close().length) {
      await this.#snapshots.empty(len => {
        this.log.progress(`Processing ${len}` + (
          ` snapshot${len !== 1 ? 's' : ''}...`), !!len);
      });
    }

    // run, close, and wait for the upload queue to empty
    if (!this.skipUploads && this.#uploads.run().close().length) {
      await this.#uploads.empty(len => {
        this.log.progress(`Uploading ${len}` + (
          ` snapshot${len !== 1 ? 's' : ''}...`), !!len);
      });
    }

    // close the any running server and browser
    await this.server?.close();
    await this.browser.close();

    if (this.build?.failed) {
      // do not finalize failed builds
      this.log.warn(`Build #${this.build.number} failed: ${this.build.url}`, meta);
    } else if (this.build) {
      // finalize the build
      await this.client.finalizeBuild(this.build.id);
      this.log.info(`Finalized build #${this.build.number}: ${this.build.url}`, meta);
    } else {
      // no build was ever created (likely failed while deferred)
      this.log.warn('Build not created', meta);
    }

    this.readyState = 3;
  }

  // Deprecated capture method
  capture(options) {
    this.log.deprecated('The #capture() method will be ' + (
      'removed in 1.0.0. Use #snapshot() instead.'));
    return this.snapshot(options);
  }

  // Takes one or more snapshots of a page while discovering resources to upload with the
  // snapshot. If an existing dom snapshot is provided, it will be served as the root resource
  // during asset discovery. Once asset discovery has completed, the queued snapshot will resolve
  // and an upload task will be queued separately.
  snapshot(options) {
    if (this.readyState !== 1) {
      throw new Error('Not running');
    }

    let {
      url,
      name,
      discovery,
      domSnapshot,
      execute,
      waitForTimeout,
      waitForSelector,
      additionalSnapshots,
      ...conf
    } = getSnapshotConfig(options, this.config, this.log);

    let meta = {
      snapshot: { name },
      build: this.build
    };

    let maybeDebug = (val, msg) => {
      if (val != null) this.log.debug(msg(val), meta);
    };

    // clear any existing pending upload for the same snapshot (for retries)
    this.#uploads.clear(`upload/${name}`);

    // resolves after asset discovery has finished and the upload has been queued
    return this.#snapshots.push(`snapshot/${name}`, async () => {
      let resources = new Map();
      let root, page;

      try {
        this.log.debug('---------');
        this.log.debug('Handling snapshot:', meta);
        this.log.debug(`-> name: ${name}`, meta);
        this.log.debug(`-> url: ${url}`, meta);
        maybeDebug(conf.widths, v => `-> widths: ${v.join('px, ')}px`);
        maybeDebug(conf.minHeight, v => `-> minHeight: ${v}px`);
        maybeDebug(conf.enableJavaScript, v => `-> enableJavaScript: ${v}`);
        maybeDebug(options.discovery?.allowedHostnames, v => `-> discovery.allowedHostnames: ${v}`);
        maybeDebug(options.discovery?.requestHeaders, v => `-> discovery.requestHeaders: ${JSON.stringify(v)}`);
        maybeDebug(options.discovery?.authorization, v => `-> discovery.authorization: ${JSON.stringify(v)}`);
        maybeDebug(options.discovery?.disableCache, v => `-> discovery.disableCache: ${v}`);
        maybeDebug(options.discovery?.userAgent, v => `-> discovery.userAgent: ${v}`);
        maybeDebug(options.waitForTimeout, v => `-> waitForTimeout: ${v}`);
        maybeDebug(options.waitForSelector, v => `-> waitForSelector: ${v}`);
        maybeDebug(options.execute, v => `-> execute: ${v}`);
        maybeDebug(conf.clientInfo, v => `-> clientInfo: ${v}`);
        maybeDebug(conf.environmentInfo, v => `-> environmentInfo: ${v}`);

        // create the root resource if a dom snapshot was provided
        if (domSnapshot) {
          root = createRootResource(url, domSnapshot);
        }

        // copy widths to prevent mutation later
        let widths = conf.widths.slice();

        // open a new browser page
        page = await this.browser.page({
          networkIdleTimeout: this.config.discovery.networkIdleTimeout,
          enableJavaScript: conf.enableJavaScript ?? !domSnapshot,
          requestHeaders: discovery.requestHeaders,
          authorization: discovery.authorization,
          userAgent: discovery.userAgent,
          meta,

          // enable network inteception
          intercept: {
            disableCache: discovery.disableCache,
            allowedHostnames: discovery.allowedHostnames,
            getResource: url => url === root?.url ? root : (
              resources.get(url) || this.#cache.get(url)
            ),
            addResource: resource => {
              if (resource.root) return;
              resources.set(resource.url, resource);
              this.#cache.set(resource.url, resource);
            }
          }
        });

        // set the initial page size
        await page.resize({
          width: widths.shift(),
          height: conf.minHeight
        });

        // navigate to the url
        await page.goto(url);

        // trigger resize events for other widths
        for (let width of widths) {
          await page.resize({ width, height: conf.minHeight });
        }

        // create and add a percy-css resource
        let percyCSS = createPercyCSSResource(url, conf.percyCSS);
        if (percyCSS) resources.set(percyCSS.url, percyCSS);

        if (root) {
          // ensure asset discovery has finished before uploading
          await page.network.idle(({ url }) => (
            hostnameMatches(discovery.allowedHostnames, url)
          ));

          root = injectPercyCSS(root, percyCSS);
          this.log.info(`Snapshot taken: ${name}`, meta);
          this._scheduleUpload(name, conf, [root, ...resources.values()]);
        } else {
          // capture additional snapshots sequentially
          let rootSnapshot = { name, waitForTimeout, waitForSelector, execute };
          let allSnapshots = [rootSnapshot, ...(additionalSnapshots || [])];

          for (let { name, prefix = '', suffix = '', ...opts } of allSnapshots) {
            name ||= `${prefix}${rootSnapshot.name}${suffix}`;
            this.log.debug(`Taking snapshot: ${name}`, meta);

            // will wait for timeouts, selectors, and additional network activity
            let { url, dom } = await page.snapshot({ ...conf, ...opts });
            let root = injectPercyCSS(createRootResource(url, dom), percyCSS);
            resources.delete(root.url); // remove any discovered root resource

            this.log.info(`Snapshot taken: ${name}`, meta);
            this._scheduleUpload(name, conf, [root, ...resources.values()]);
          }
        }
      } catch (error) {
        this.log.error(`Encountered an error taking snapshot: ${name}`, meta);
        this.log.error(error, meta);
      } finally {
        await page?.close();
      }
    });
  }

  // Queues a snapshot upload with the provided configuration options and resources
  _scheduleUpload(name, conf, resources) {
    this.#uploads.push(`upload/${name}`, async () => {
      try {
        // attach a log resource for debugging
        resources = resources.concat(
          createLogResource(logger.query(l => (
            l.meta.snapshot?.name === name
          )))
        );

        await this.client.sendSnapshot(this.build.id, {
          ...conf, name, resources
        });
      } catch (error) {
        let meta = { snapshot: { name }, build: this.build };
        let failed = error.response?.status === 422 && (
          error.response.body.errors.find(e => (
            e.source?.pointer === '/data/attributes/build'
          )));

        this.log.error(`Encountered an error uploading snapshot: ${name}`, meta);
        this.log.error(failed?.detail ?? error, meta);

        // build failed at some point, stop accepting snapshots
        if (failed) {
          this.build.failed = true;
          this.close();
        }
      }
    });
  }
}
