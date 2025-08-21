import csvtojson from 'csvtojson';
import { isArraySafe } from '../../../libs/arrays.js';
import { isObjectSafe } from '../../../libs/objects.js';
import { getModelAttributes, getModel } from '../../utils/models.js';
// import { EnumValues } from '../../../types.js';
// import { SchemaUID } from '../../types.js';

const inputFormatToParser = {
  csv: parseCsv,
  jso: parseJso,
  json: parseJson,
  postgres: parsePostgresJson,
};

const InputFormats = Object.keys(inputFormatToParser);

/**
 * Parse input data.
 */
async function parseInputData(format, dataRaw, { slug, importAsDrafts = true }) {
  const parser = inputFormatToParser[format];
  if (!parser) {
    throw new Error(`Data input format ${format} is not supported.`);
  }

  const data = await parser(dataRaw, { slug, importAsDrafts });
  return data;
}

async function parseCsv(dataRaw, { slug, importAsDrafts = true }) {
  let data = await csvtojson().fromString(dataRaw);
  
  // Check if the model has draftAndPublish enabled
  const model = getModel(slug);
  const hasDraftAndPublish = model?.options?.draftAndPublish === true;

  const relationNames = getModelAttributes(slug, { filterType: ['component', 'dynamiczone', 'media', 'relation'] }).map((a) => a.name);
  const dateTimeFields = getModelAttributes(slug, { filterType: ['datetime', 'date', 'time'] }).map((a) => a.name);
  const booleanFields = getModelAttributes(slug, { filterType: ['boolean'] }).map((a) => a.name);
  const numberFields = getModelAttributes(slug, { filterType: ['integer', 'biginteger', 'float', 'decimal'] }).map((a) => a.name);
  
  data = data.map((datum) => {
    // Parse relation fields (JSON)
    for (let name of relationNames) {
      if (datum[name] && datum[name] !== '' && datum[name] !== 'null' && datum[name] !== 'undefined') {
        try {
          datum[name] = JSON.parse(datum[name]);
        } catch (err) {
          strapi.log.error(`Error parsing relation field ${name}:`, err);
          // If JSON parse fails, keep the original value or set to null
          datum[name] = null;
        }
      } else {
        // Set empty/null/undefined values to null
        datum[name] = null;
      }
    }
    
    // Parse date/datetime fields
    for (let name of dateTimeFields) {
      if (datum[name] && datum[name] !== 'null' && datum[name] !== '') {
        try {
          // Check if it's a valid date string
          const dateValue = new Date(datum[name]);
          if (!isNaN(dateValue.getTime())) {
            datum[name] = dateValue.toISOString();
          }
        } catch (err) {
          strapi.log.error(`Error parsing date field ${name}:`, err);
        }
      } else if (datum[name] === 'null' || datum[name] === '') {
        datum[name] = null;
      }
    }
    
    // Parse boolean fields
    for (let name of booleanFields) {
      if (datum[name] !== undefined) {
        if (datum[name] === 'true' || datum[name] === '1' || datum[name] === true) {
          datum[name] = true;
        } else if (datum[name] === 'false' || datum[name] === '0' || datum[name] === false) {
          datum[name] = false;
        } else if (datum[name] === 'null' || datum[name] === '') {
          datum[name] = null;
        }
      }
    }
    
    // Parse number fields
    for (let name of numberFields) {
      if (datum[name] !== undefined && datum[name] !== '' && datum[name] !== 'null') {
        const numValue = Number(datum[name]);
        if (!isNaN(numValue)) {
          datum[name] = numValue;
        } else {
          datum[name] = null;
        }
      } else if (datum[name] === 'null' || datum[name] === '') {
        datum[name] = null;
      }
    }
    
    // Handle publishedAt field based on draftAndPublish setting
    if (hasDraftAndPublish && importAsDrafts) {
      // Force record to be draft
      datum.publishedAt = null;
    } else if (!hasDraftAndPublish && datum.publishedAt !== undefined) {
      // Remove publishedAt field for entities without draft & publish
      delete datum.publishedAt;
    }
    // If hasDraftAndPublish && !importAsDrafts, keep the original publishedAt value
    
    return datum;
  });

  return data;
}

async function parseJson(dataRaw, { slug, importAsDrafts = true }) {
  let data = JSON.parse(dataRaw);
  
  // Check if the model has draftAndPublish enabled
  const model = getModel(slug);
  const hasDraftAndPublish = model?.options?.draftAndPublish === true;
  
  // Only handle publishedAt if the entity supports draft & publish
  if (hasDraftAndPublish && importAsDrafts) {
    // Force all records to be drafts
    if (Array.isArray(data)) {
      data = data.map(item => ({
        ...item,
        publishedAt: null
      }));
    } else if (typeof data === 'object') {
      data.publishedAt = null;
    }
  } else if (!hasDraftAndPublish) {
    // Remove publishedAt field for entities without draft & publish
    if (Array.isArray(data)) {
      data = data.map(item => {
        const { publishedAt, ...rest } = item;
        return rest;
      });
    } else if (typeof data === 'object' && data.publishedAt !== undefined) {
      delete data.publishedAt;
    }
  }
  
  return data;
}

async function parseJso(dataRaw) {
  if (!isObjectSafe(dataRaw) && !isArraySafe(dataRaw)) {
    throw new Error(`To import JSO, data must be an array or an object`);
  }

  return dataRaw;
}

async function parsePostgresJson(dataRaw, { slug, importAsDrafts = true }) {
  try {
    // Check if the model has draftAndPublish enabled
    const model = getModel(slug);
    const hasDraftAndPublish = model?.options?.draftAndPublish === true;
    
    strapi.log.info(`parsePostgresJson - slug: ${slug}, hasDraftAndPublish: ${hasDraftAndPublish}, importAsDrafts: ${importAsDrafts}`);
    
    // Parse the JSON string
    let data = JSON.parse(dataRaw);
    
    strapi.log.info(`After JSON.parse - type: ${typeof data}, isArray: ${Array.isArray(data)}, length: ${Array.isArray(data) ? data.length : 'N/A'}`);
    
    // If it's not an array, make it an array
    if (!isArraySafe(data)) {
      strapi.log.info(`Data is not array-safe, converting to array`);
      data = [data];
    }
    
    strapi.log.info(`Parsing PostgreSQL JSON for ${slug}: ${data.length} records found, importAsDrafts: ${importAsDrafts}`);
    
    // Transform PostgreSQL JSON format to Strapi format
    // The mediation.json file has a specific structure that needs to be mapped
    const transformedData = data.map((item, index) => {
      try {
        const transformed = {
          // Map core fields that exist in the Strapi model
          name: item.name,
          
          // Configuration field - keep as is if it's a string
          configuration: typeof item.configuration === 'string' 
            ? item.configuration 
            : JSON.stringify(item.configuration),
          
          // Map version field
          version: item.version || 'main',
        };
        
        // Only include id if we want to update existing records
        // The import system will use the name field as the identifier based on the schema
        // Don't include the PostgreSQL id as it may conflict with Strapi's auto-generated ids
        // if (item.id) {
        //   transformed.id = item.id;
        // }
        
        // Handle publishedAt based on draftAndPublish setting and importAsDrafts flag
        if (hasDraftAndPublish) {
          // Only handle publishedAt if the entity supports draft & publish
          if (importAsDrafts) {
            // Force all records to be drafts
            transformed.publishedAt = null;
          } else {
            // Keep the original published status
            if (item.published_at !== undefined) {
              if (item.published_at === null) {
                transformed.publishedAt = null;
              } else {
                const date = new Date(item.published_at);
                if (!isNaN(date.getTime())) {
                  transformed.publishedAt = date.toISOString();
                }
              }
            }
          }
        }
        // If entity doesn't support draft & publish, don't include publishedAt at all
        
        // Log the transformation for debugging
        strapi.log.info(`Successfully transformed PostgreSQL record ${index + 1}: ${item.name}`);
        
        return transformed;
      } catch (itemError) {
        strapi.log.error(`Error transforming PostgreSQL record ${index + 1} (${item.name}):`, itemError);
        throw itemError;
      }
    });
    
    strapi.log.info(`PostgreSQL JSON parsing complete: ${transformedData.length} records transformed`);
    return transformedData;
  } catch (error) {
    strapi.log.error('Error parsing PostgreSQL JSON:', error);
    throw new Error(`Failed to parse PostgreSQL JSON: ${error.message}`);
  }
}

export { InputFormats, parseInputData };
