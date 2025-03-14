/*
 * Copyright ©2025 Ewsgit <https://ewsgit.uk> and YourDash <https://yourdash.ewsgit.uk> contributors.
 * YourDash is licensed under the MIT License. (https://mit.ewsgit.uk)
 */

import dotenv from "dotenv";
import pg from "pg";
import Applications from "./applications.js";
import Authorization from "./authorization.js";
import Events from "./event.js";
import Filesystem from "./filesystem.js";
import { resizeImage } from "./image.js";
import Log from "./log.js";
import RequestManager from "./requestManager.js";
import ResourceManager from "./resourceManager.js";
import { InstanceStatus } from "./types/instanceStatus.js";
import User, { createUser, repairUser } from "./user.js";
import path from "path";
import fs from "fs";
import timeTaken from "./timer.js";

dotenv.config();

class Instance {
  flags!: {
    isDebugMode: boolean;
    logQueryParameters: boolean;
    logOptionsRequests: boolean;
    isDevMode: boolean;
    port: number;
    postgresPassword: string;
    postgresPort: number;
    postgresUser: string;
    postgresDatabase: string;
    cookieSecret: string;
  };
  log!: Log;
  resourceManager!: ResourceManager;
  requestManager!: RequestManager;
  request!: RequestManager["app"];
  authorization!: Authorization;
  database!: pg.Client;
  filesystem!: Filesystem;
  events!: Events;
  applications!: Applications;
  private status: InstanceStatus = InstanceStatus.UNKNOWN;

  constructor() {
    this.__internal_init().then(() => {
      return 0;
    });
    return this;
  }

  async __internal_init() {
    // FLAGS FOR DEVELOPMENT FEATURES
    this.flags = {
      isDebugMode: process.env.IS_DEBUGMODE === "true" || false,
      logOptionsRequests: process.env.LOG_OPTIONS_REQUESTS === "true" || false,
      logQueryParameters: process.env.LOG_QUERY_PARAMETERS === "true" || false,
      isDevMode: process.env.IS_DEVMODE === "true" || false,
      port: Number(process.env.PORT) || 3563,
      postgresPassword: process.env.POSTGRES_PASSWORD || "postgres",
      postgresPort: Number(process.env.POSTGRES_PORT) || 5432,
      postgresUser: process.env.POSTGRES_USER || "postgres",
      postgresDatabase: process.env.POSTGRES_DATABASE || "yourdash",
      cookieSecret: "this should be a random and unknown string to ensure security",
    };

    try {
      let tempDatabaseClient: pg.Client = new pg.Client({
        password: this.flags.postgresPassword,
        user: this.flags.postgresUser,
        database: "postgres",
      });

      await tempDatabaseClient.connect();

      // create the required database if it doesn't already exist (by default this is 'yourdash')
      try {
        await tempDatabaseClient.query("CREATE DATABASE $1", [this.flags.postgresDatabase]);
      } catch (e) {}
    } catch (e) {
      console.error(
        "database",
        "Failed to setup pre-startup connection to PostgreSQL Database,\nplease ensure that you have PostgreSQL installed, and the default 'postgres' database exists.",
      );
    }

    this.log = new Log(this);

    try {
      this.database = new pg.Client({
        password: this.flags.postgresPassword,
        port: this.flags.postgresPort,
        user: this.flags.postgresUser,
        database: "yourdash",
      });
    } catch (e) {
      this.log.error("database", "Failed to setup connection to PostgreSQL Database");
    }

    this.log.info("startup", "Connecting to PostgreSQL Database");
    try {
      await this.database.connect();
      this.log.info("startup", "Connected to PostgreSQL Database");
    } catch (e) {
      this.log.error("database", "Failed to connect to PostgreSQL Database");
      this.log.error("instance", "Instance will now quit due to startup failure");
      this.log.error(
        "instance",
        "Please ensure that Postgresql is installed, has the default \"postgres\" database and the values for 'postgresPassword', 'postgresPort' & 'postgresUser' are correct.",
      );
      return false;
    }

    try {
      await this.database.query(`CREATE TABLE IF NOT EXISTS users
                                  (
                                    user_id        serial primary key,
                                    username       text,
                                    forename       text,
                                    surname        text,
                                    bio            text DEFAULT 'I''m new here, say hello!.',
                                    storage_quota  bigint,
                                    permissions    text[],
                                    session_tokens text[],
                                    nextcloud_session_tokens text[],
                                    password_hash  text
                                  )`);
      this.log.info("database", `Table ${this.log.addEmphasisToString("users")} has been created if it did not already exist.`);
    } catch (e) {
      console.error(e);
      this.log.error("database", `Failed to create table ${this.log.addEmphasisToString("users")}!`);
    }

    try {
      await this.database.query(`CREATE TABLE IF NOT EXISTS teams
                                  (
                                    team_id        serial primary key,
                                    teamname       text,
                                    owner_username text,
                                    members        text[],
                                    bio            text
                                  )`);
      this.log.info("database", `Table ${this.log.addEmphasisToString("teams")} has been created if it did not already exist.`);
    } catch (e) {
      console.error(e);
      this.log.error("database", `Failed to create table ${this.log.addEmphasisToString("teams")}!`);
    }

    try {
      const doesConfigurationExist = await this.database.query(`SELECT EXISTS (
    SELECT FROM
        pg_tables
    WHERE
        schemaname = 'public' AND
        tablename  = 'configuration'
    );`);

      if (!doesConfigurationExist.rows[0].exists) {
        this.log.info("database", `Table ${this.log.addEmphasisToString("configuration")} will be created.`);
        await this.database.query(`CREATE TABLE IF NOT EXISTS configuration
                                  (
                                    config_version              serial primary key,
                                    creation_date               bigint,
                                    administrator_username      text   DEFAULT 'admin',
                                    display_name                text   DEFAULT 'YourDash Instance',
                                    external_url                text   DEFAULT 'http://localhost:3563',
                                    description                 text   DEFAULT 'This is the default instance description. Hey Admin, this can be changed in the system settings!.',
                                    administrator_contact_email text,
                                    installed_applications      text[] DEFAULT '{ "uk-ewsgit-dash", "uk-ewsgit-files", "uk-ewsgit-photos", "uk-ewsgit-weather", "uk-ewsgit-store", "uk-ewsgit-settings" }',
                                    default_pinned_applications text[] DEFAULT '{ "uk-ewsgit-dash", "uk-ewsgit-files", "uk-ewsgit-store", "uk-ewsgit-weather" }'
                                  )`);
        this.log.info("database", `Table ${this.log.addEmphasisToString("configuration")} has been created as it did not already exist.`);

        await this.database.query("INSERT INTO configuration(creation_date) VALUES ($1);", [Date.now()]);
      }
    } catch (e) {
      console.error(e);
      this.log.error("database", `Failed to create table ${this.log.addEmphasisToString("config")}!`);
    }

    this.events = new Events(this);
    instance.events.createEvent("yourdash_user_repair");

    this.authorization = new Authorization(this);
    this.filesystem = new Filesystem(this);
    this.resourceManager = new ResourceManager(this);
    this.requestManager = new RequestManager(this);
    this.request = this.requestManager.app;
    this.applications = new Applications(this);

    this.startup()
      .then((status: boolean) => {
        if (status) {
          this.setStatus(InstanceStatus.OK);
        } else {
          process.exit(1);
        }

        return 0;
      })
      .catch((err) => {
        this.log.error("startup", err);
        this.setStatus(InstanceStatus.NON_FUNCTIONAL);
      });

    return this;
  }

  async startup(): Promise<boolean> {
    await timeTaken("filesystem_startup", async () => await this.filesystem.__internal_startup());
    await timeTaken("request_manager_startup", async () => await this.requestManager.__internal_startup());
    await timeTaken("resource_manager_startup", async () => await this.resourceManager.__internal_startup());
    try {
      await this.database.query(`CREATE TABLE IF NOT EXISTS panel_configuration
                                  (
                                    config_version              serial  primary key,
                                    username                    text    NOT NULL,
                                    pinned_applications         text[]  DEFAULT '{ "uk-ewsgit-dash", "uk-ewsgit-files", "uk-ewsgit-store", "uk-ewsgit-weather" }',
                                    widgets                     text[]  DEFAULT '{ "InstanceLogo", "ApplicationLauncher", "Separator", "QuickShortcuts", "LocalhostIndicator", "UserProfile" }',
                                    side                        text    DEFAULT 'left',
                                    size                        text    DEFAULT 'medium'
                                  )`);
      this.log.info(
        "database",
        `Table ${this.log.addEmphasisToString("panel_configuration")} has been created if it did not already exist.`,
      );
    } catch (e) {
      console.error(e);
      this.log.error("database", `Failed to create table ${this.log.addEmphasisToString("panel_configuration")}!`);
    }

    await this.__internal_generateInstanceLogos();
    this.log.info("startup", "YourDash RequestManager Startup Complete!");

    this.log.info("startup", "Loading applications...");

    const applications = await this.applications.getInstalledApplications();
    this.log.info("applications", `loading applications: '${applications}'`);

    for (const app of applications) {
      await this.applications.loadApplication(app);
      this.log.info("application", `Application ${app} loaded successfully!`);
    }

    this.log.info("application", `All applications have loaded!`);

    const adminUser = new User("admin");

    if (!(await adminUser.doesExist())) {
      const adminUser = await createUser("admin");
      await adminUser.setForename("Admin");
      await adminUser.setSurname("Istrator");
      await this.authorization.setUserPassword("admin", "password");
    }

    const users = await this.database.query("SELECT username FROM users");

    for (const user of users.rows) {
      await repairUser(user.username);
    }

    await this.requestManager.__internal_beginListening();
    this.log.info("startup", "YourDash Instance Startup Complete");

    // generate the appRouter
    await (async () => {
      let fileTemplate = `/**
 * This file is auto-generated by backend/src/core.ts during vite server startup don't edit this file for any reason
*/

import React from "react";
import { Route, Routes } from "react-router";
import loadable from "@loadable/component";

/* region loadable */const AppRouter=[{/* region routes */}];export default AppRouter
`;

      let loadableRegionReplacement = "";
      let routeRegionReplacement = "";

      for (const [index, application] of this.applications.loadedApplications.entries()) {
        loadableRegionReplacement += `const Application${index}=loadable(()=>import("../../../applications/${path.posix.join(path.basename(application.__internal_initializedPath), "./web/src/index.tsx")}"));`;
        routeRegionReplacement += `<Route path={"${application.__internal_params.id}/*"} element={<Application${index}/>}/>,`;
      }

      fileTemplate = fileTemplate.replace("/* region loadable */", loadableRegionReplacement);
      fileTemplate = fileTemplate.replace("{/* region routes */}", routeRegionReplacement);

      Bun.write(path.resolve(process.cwd(), "./src/web/src/app/AppRouter.tsx"), fileTemplate).then(() => {
        this.log.info("core/startup", "Generated AppRouter.tsx Successfully");
      });
    })();

    this.log.info("application", "Application Frontends have been loaded successfully!");

    return true;
  }

  getStatus(): InstanceStatus {
    return this.status;
  }

  setStatus(status: InstanceStatus): this {
    this.status = status;
    this.log.info(
      "instance",
      `Instance status has been set to ${this.log.addEmphasisToString(`'INSTANCE_STATUS.${InstanceStatus[status]}'`)}`,
    );

    return this;
  }

  async __internal_generateInstanceLogos() {
    this.log.info("instance", `Generating instanceLogos.`);
    let instanceLogoPath = path.join(this.filesystem.commonPaths.systemDirectory(), "instanceLogo.png");

    const requiredDimensions = [32, 40, 64, 128, 256, 512, 768, 1024];

    for (const dimension of requiredDimensions) {
      if (
        await this.filesystem.doesPathExist(
          path.join(path.join(this.filesystem.commonPaths.systemDirectory(), `instanceLogo${dimension}.webp`)),
        )
      ) {
        this.log.info("instance", `instanceLogo @ ${dimension} already exists. Not generating new logo`);
        continue;
      }

      await resizeImage(
        instanceLogoPath,
        dimension,
        dimension,
        path.join(path.join(this.filesystem.commonPaths.systemDirectory(), `instanceLogo${dimension}.webp`)),
        "webp",
      );

      this.log.info("instance", `Genertated instanceLogo @ ${dimension}.`);
    }
  }
}

export { type Instance };

const instance = new Instance();

export default instance;

/*
 * https://fastify-vite.dev/guide/getting-started
 *
 * https://github.com/fastify/fastify-schedule
 *
 * https://github.com/fastify/session
 *
 * https://github.com/fastify/fastify-websocket
 *
 * https://github.com/turkerdev/fastify-type-provider-zod
 *
 * https://github.com/fastify/fastify-cors
 *
 * https://github.com/fastify/fastify-cookie
 *
 * https://github.com/fastify/fastify-express
 *
 * https://node-postgres.com/
 *
 * https://github.com/fastify/fastify-auth
 *
 * https://fastify.dev/docs/latest/Reference/Hooks/#hooks
 *
 * http://localhost:3563/swagger
 */
