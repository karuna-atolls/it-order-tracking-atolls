/**
 * Business settings for the IT order notifier.
 * Nothing secret goes here — tokens and keys come from environment secrets (see server/env.ts).
 * This is the first file to edit when customising the app.
 */
import type { Category, Source } from './types';

export const config = {
  /** Person who is tagged in Slack and on the Jira ticket when something needs attention. */
  admin: {
    email: 'karunamoorthy.s@atolls.com',
    /** Other people (emails) who may press "Send" on previews in the master channel. */
    approvers: [] as string[],
  },

  timezone: 'Europe/Paris',

  jira: {
    baseUrl: 'https://atolls.atlassian.net', // no trailing slash
    projectKey: 'IS',                           // tickets look like IS-73844
    fields: {
      /** "To which Office should the items be delivered?" — filled = office delivery, empty = home delivery. */
      deliveryOffice: 'customfield_XXXXX',
      orderStatus: '',  // optional single-select field that mirrors the overall order status
      orderNumber: '',  // optional text field for the supplier order number
    },
    /** Order updates are written as customer-visible comments; technical notes are always internal. */
    publicComments: true,
    /** The ticket is closed by moving it to the first of these statuses that the workflow offers. */
    closeStatuses: ['Resolved', 'Done', 'Closed'],
    closeResolution: 'Done',
  },

  /**
   * Suppliers. Only emails whose sender address is in allowedSenders are ever read.
   * Add Amazon / Apple Business here later.
   */
  sources: [
    {
      name: 'Bechtle',
      allowedSenders: ['vertrieb.rheinland@bechtle.com'],
      notifyUserOnCancel: false, // cancellations / payment problems go to the master channel only
    },
  ] as Source[],

  gmail: {
    lookbackDays: 14, // only emails newer than this are considered
    maxPerRun: 25,
    maxAttempts: 3,   // tries before an email is reported as failed
  },

  gemini: { model: 'gemini-3.8-flash' },

  slack: {
    /** Master channel: receives every order update, one thread per order. Channel name or ID. */
    masterChannel: 'it-hardware-orders',
    /** Office (as chosen on the ticket) -> that office's Slack channel. */
    officeChannels: {
      London: 'london-it',
      Warsaw: 'warsaw-it',
      Madrid: 'madrid-it',
      Munich: 'munich-it',
      Berlin: 'berlin-it',
      Amsterdam: 'amsterdam-it',
      Paris: 'paris-it',
    } as Record<string, string>,
    /** If a Jira email isn't found in Slack, the same name is tried on these domains. */
    emailDomains: ['atolls.com', 'joingsg.com'],
  },

  notifications: {
    /**
     * Starting value of the "automatic sending" switch (the switch itself is on the dashboard).
     * false = review mode: nothing goes to requesters or office channels until an approver presses
     * "Send" on the preview in the master channel; Jira order comments are internal.
     */
    autoSendDefault: false,
    /**
     * 'digest'    = the requester gets one summary DM per digest run (default: once a day).
     * 'perParcel' = the requester gets a DM right after every supplier email.
     */
    userDmMode: 'digest' as 'digest' | 'perParcel',
    /** In digest mode, still send "delivered" news straight away. */
    deliveredImmediately: false,
  },

  reminders: {
    everyDays: 2,          // after everything is delivered, until the ticket is closed
    escalateAfterDays: 10, // then the admin is tagged in the master channel
  },

  /** Tracking links built from the parcel number when the email has no usable link. {n} = parcel number. */
  carriers: {
    UPS: 'https://www.ups.com/track?tracknum={n}',
    GLS: 'https://gls-group.com/track/{n}',
    DHL: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id={n}',
    DPD: 'https://tracking.dpd.de/parcelstatus?query={n}',
  } as Record<string, string>,

  assets: {
    schemaName: 'IT Employee Assets',
    /** Status given to new objects. Must be one of the statuses that exist in the schema. */
    statusOnCreate: 'In Use',
    /**
     * Device category (decided by Gemini from the product name) -> Assets object type.
     * needsSerial: the requester is asked for the serial number before the ticket is closed.
     * objectType null = no asset record (services, cables, licences).
     */
    categories: {
      laptop: { objectType: 'Laptops', needsSerial: true },
      monitor: { objectType: 'Monitors', needsSerial: true },
      mobile_phone: { objectType: 'Mobile Phones', needsSerial: true },
      tablet: { objectType: 'Tablets', needsSerial: true },
      mouse: { objectType: 'Mouse', needsSerial: false },
      keyboard: { objectType: 'Keyboard', needsSerial: false },
      docking_station: { objectType: 'Docking Station (USB HUB)', needsSerial: false },
      headphone: { objectType: 'HeadPhone', needsSerial: false },
      accessory: { objectType: 'Accessories', needsSerial: false },
      other: { objectType: null, needsSerial: false },
    } as Record<Category, { objectType: string | null; needsSerial: boolean }>,
    /**
     * Which Assets attribute (by its name in the schema) receives which value.
     * Attribute IDs are looked up automatically. Any other mandatory text attribute
     * (for example "Growrk Title" on Accessories) is filled with the device model.
     */
    attributeNames: {
      serial: ['Serial Number'],
      owner: ['Owner'],
      status: ['Status'],
      manufacturer: ['Manufacturer'],
      model: ['Model'],
      office: ['Office'],
      legalEntity: ['Legal Entity'],
      country: ['Country'],
      department: ['Department', 'Departments'],
      purchaseDate: ['Purchase Date'],
      notes: ['Notes'],
    } as Record<string, string[]>,
  },

  /** Firestore collections are prefixed so they never clash with anything else in the project. */
  store: { collectionPrefix: 'itOrders_' },
};

export type AppConfig = typeof config;
