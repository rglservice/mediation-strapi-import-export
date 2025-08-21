import { isArraySafe, toArray } from '../../../libs/arrays.js';
import { ObjectBuilder, isObjectSafe } from '../../../libs/objects.js';
import { CustomSlugs } from '../../config/constants.js';
import { getModelAttributes, getModel } from '../../utils/models.js';
import { findOrImportFile } from './utils/file.js';
import { parseInputData } from './parsers.js';

/**
 * @typedef {Object} ImportDataRes
 * @property {Array<ImportDataFailures>} failures
 */
/**
 * Represents failed imports.
 * @typedef {Object} ImportDataFailures
 * @property {Error} error - Error raised.
 * @property {Object} data - Data for which import failed.
 */
/**
 * Import data.
 * @param {Array<Object>} dataRaw - Data to import.
 * @param {Object} options
 * @param {string} options.slug - Slug of the model to import.
 * @param {("csv" | "json")} options.format - Format of the imported data.
 * @param {Object} options.user - User importing the data.
 * @param {Object} options.idField - Field used as unique identifier.
 * @returns {Promise<ImportDataRes>}
 */
const importData = async (dataRaw, { slug, format, user, idField, importAsDrafts = true }) => {
  // Check if the model has draftAndPublish enabled
  const model = getModel(slug);
  const hasDraftAndPublish = model?.options?.draftAndPublish === true;
  
  strapi.log.info(`Model ${slug} - draftAndPublish: ${hasDraftAndPublish}, importAsDrafts: ${importAsDrafts}`);
  
  let data;
  
  // If format is 'jso', the data is already parsed
  if (format === 'jso') {
    data = dataRaw;
  } else {
    // Only apply importAsDrafts if the model supports draft & publish
    const shouldApplyDraftMode = hasDraftAndPublish ? importAsDrafts : false;
    data = await parseInputData(format, dataRaw, { slug, importAsDrafts: shouldApplyDraftMode });
  }
  
  data = toArray(data);

  // Log import action without data content to prevent console flooding
  strapi.log.info(`Importing ${format} data for ${slug} - ${data.length} items to process`);
  let res;
  if (slug === CustomSlugs.MEDIA) {
    res = await importMedia(data, { user });
  } else {
    res = await importOtherSlug(data, { slug, user, idField, hasDraftAndPublish, importAsDrafts });
  }

  return res;
};

const importMedia = async (fileData, { user }) => {
  const processed = [];
  for (let fileDatum of fileData) {
    let res;
    try {
      await findOrImportFile(fileDatum, user, { allowedFileTypes: ['any'] });
      res = { success: true };
    } catch (err) {
      strapi.log.error(err);
      res = { success: false, error: err.message, args: [fileDatum] };
    }
    processed.push(res);
  }

  const failures = processed.filter((p) => !p.success).map((f) => ({ error: f.error, data: f.args[0] }));

  return {
    failures,
  };
};

const importOtherSlug = async (data, { slug, user, idField, hasDraftAndPublish, importAsDrafts }) => {
  const processed = [];
  strapi.log.info(`Processing ${data.length} items for ${slug} using idField: ${idField}, draftAndPublish: ${hasDraftAndPublish}, importAsDrafts: ${importAsDrafts}`);
  
  for (let i = 0; i < data.length; i++) {
    const datum = data[i];
    let res;
    try {
      strapi.log.info(`Processing item ${i + 1}/${data.length}: ${datum[idField] || datum.name || datum.id || 'unknown'}`);
      
      // If the entity doesn't support draft & publish, remove publishedAt field
      if (!hasDraftAndPublish && datum.publishedAt !== undefined) {
        delete datum.publishedAt;
        strapi.log.info(`Removed publishedAt field for non-draft entity`);
      }
      
      await updateOrCreate(user, slug, datum, idField);
      res = { success: true };
      strapi.log.info(`Successfully processed item ${i + 1}/${data.length}`);
    } catch (err) {
      strapi.log.error(`Error processing item ${i + 1}/${data.length}:`, err);
      res = { success: false, error: err.message, args: [datum] };
    }
    processed.push(res);
  }

  const failures = processed.filter((p) => !p.success).map((f) => ({ error: f.error, data: f.args[0] }));
  
  strapi.log.info(`Import complete: ${processed.length - failures.length} succeeded, ${failures.length} failed`);

  return {
    failures,
  };
};

/**
 * Update or create entries for a given model.
 * @param {Object} user - User importing the data.
 * @param {string} slug - Slug of the model.
 * @param {Object} data - Data to update/create entries from.
 * @param {string} idField - Field used as unique identifier.
 * @returns Updated/created entry.
 */
const updateOrCreate = async (user, slug, data, idField = 'id') => {
  const relationAttributes = getModelAttributes(slug, { filterType: ['component', 'dynamiczone', 'media', 'relation'] });
  for (let attribute of relationAttributes) {
    data[attribute.name] = await updateOrCreateRelation(user, attribute, data[attribute.name]);
  }

  let entry;
  const model = getModel(slug);
  if (model.kind === 'singleType') {
    entry = await updateOrCreateSingleType(user, slug, data, idField);
  } else {
    entry = await updateOrCreateCollectionType(user, slug, data, idField);
  }
  return entry;
};

const updateOrCreateCollectionType = async (user, slug, data, idField) => {
  const whereBuilder = new ObjectBuilder();
  if (data[idField]) {
    whereBuilder.extend({ [idField]: data[idField] });
  }
  const where = whereBuilder.get();
  
  strapi.log.info(`updateOrCreateCollectionType - idField: ${idField}, where: ${JSON.stringify(where)}, data[idField]: ${data[idField]}`);

  // Prevent strapi from throwing a unique constraint error on id field.
  if (idField !== 'id') {
    delete data.id;
  }

  let entry;
  if (!where[idField]) {
    strapi.log.info(`No ${idField} field found, creating new entry`);
    entry = await strapi.db.query(slug).create({ data });
  } else {
    strapi.log.info(`Attempting to update where ${idField} = ${where[idField]}`);
    
    // First try to find the existing entry
    const existingEntry = await strapi.db.query(slug).findOne({ where });
    
    if (existingEntry) {
      strapi.log.info(`Found existing entry with id ${existingEntry.id}, updating...`);
      entry = await strapi.db.query(slug).update({ where: { id: existingEntry.id }, data });
    } else {
      strapi.log.info(`No existing entry found, creating new...`);
      entry = await strapi.db.query(slug).create({ data });
    }
  }

  return entry;
};

const updateOrCreateSingleType = async (user, slug, data, idField) => {
  delete data.id;

  let [entry] = await strapi.db.query(slug).findMany();
  if (!entry) {
    entry = await strapi.db.query(slug).create({ data });
  } else {
    entry = await strapi.db.query(slug).update({ where: { id: entry.id }, data });
  }

  return entry;
};

/**
 * Update or create a relation.
 * @param {Object} user
 * @param {Attribute} rel
 * @param {number | Object | Array<Object>} relData
 */
const updateOrCreateRelation = async (user, rel, relData) => {
  if (relData == null) {
    return null;
  }

  if (['createdBy', 'updatedBy'].includes(rel.name)) {
    return user.id;
  } else if (rel.type === 'dynamiczone') {
    const components = [];
    for (const componentDatum of relData || []) {
      let component = await updateOrCreate(user, componentDatum.__component, componentDatum);
      component = { ...component, __component: componentDatum.__component };
      components.push(component);
    }
    return components;
  } else if (rel.type === 'component') {
    relData = toArray(relData);
    relData = rel.repeatable ? relData : relData.slice(0, 1);
    const entryIds = [];
    for (const relDatum of relData) {
      if (typeof relDatum === 'number') {
        entryIds.push(relDatum);
      } else if (isObjectSafe(relDatum)) {
        const entry = await updateOrCreate(user, rel.component, relDatum);
        if (entry?.id) {
          entryIds.push(entry.id);
        }
      }
    }
    return rel.repeatable ? entryIds : entryIds?.[0] || null;
  } else if (rel.type === 'media') {
    relData = toArray(relData);
    relData = rel.multiple ? relData : relData.slice(0, 1);
    const entryIds = [];
    for (const relDatum of relData) {
      const media = await findOrImportFile(relDatum, user, { allowedFileTypes: rel.allowedTypes ?? ['any'] });
      if (media?.id) {
        entryIds.push(media.id);
      }
    }
    return rel.multiple ? entryIds : entryIds?.[0] || null;
  } else if (rel.type === 'relation') {
    const isMultiple = isArraySafe(relData);
    relData = toArray(relData);
    const entryIds = [];
    for (const relDatum of relData) {
      if (typeof relDatum === 'number') {
        entryIds.push(relDatum);
      } else if (isObjectSafe(relDatum)) {
        const entry = await updateOrCreate(user, rel.target, relDatum);
        if (entry?.id) {
          entryIds.push(entry.id);
        }
      }
    }
    return isMultiple ? entryIds : entryIds?.[0] || null;
  }

  throw new Error(`Could not update or create relation of type ${rel.type}.`);
};

export {
  importData,
};