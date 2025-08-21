import { CustomSlugs } from '../../../config/constants.js';
import { getAllSlugs } from '../../../utils/models.js';
import { getService } from '../../../utils/utils.js';

export default ({ strapi }) => importData;

async function importData(ctx) {
  if (!hasPermissions(ctx)) {
    return ctx.forbidden();
  }

  const { user } = ctx.state;
  const { data } = ctx.request.body;
  const {slug, data:dataRaw, format, fileType, idField, importAsDrafts = true} = data
  
  strapi.log.info(`Import request received - slug: ${slug}, format: ${format}, fileType: ${fileType}, idField: ${idField}, importAsDrafts: ${importAsDrafts}`);
  
  // Determine the actual format based on fileType
  let actualFormat = format;
  if (fileType === 'postgres') {
    actualFormat = 'postgres';
  } else if (fileType === 'csv') {
    actualFormat = 'csv';
  } else if (fileType === 'strapi' && format === 'json') {
    actualFormat = 'json';
  }
  
  strapi.log.info(`Using format: ${actualFormat} for parsing`);
  
  const fileContent = await getService('import').parseInputData(actualFormat, dataRaw, { slug, importAsDrafts });
  
  strapi.log.info(`Parsed data type: ${typeof fileContent}, isArray: ${Array.isArray(fileContent)}, length: ${Array.isArray(fileContent) ? fileContent.length : 'N/A'}`);
  if (Array.isArray(fileContent) && fileContent.length > 0) {
    strapi.log.info(`First item keys: ${Object.keys(fileContent[0]).join(', ')}`);
    strapi.log.info(`Sample data - first item name: ${fileContent[0].name}`);
    if (fileContent.length > 1) {
      strapi.log.info(`Sample data - second item name: ${fileContent[1].name}`);
    }
  }

  let res;
  if (fileContent?.version === 2) {
    res = await getService('import').importDataV2(fileContent, {
      slug,
      user,
      idField,
      importAsDrafts,
    });
  } else {
    // For postgres format, we've already parsed the data, so pass the parsed content
    // For other formats, importData will handle the parsing internally
    if (actualFormat === 'postgres') {
      // Pass the already parsed data directly to avoid double parsing
      res = await getService('import').importData(fileContent, {
        slug,
        format: 'jso', // Use 'jso' format to indicate pre-parsed JavaScript object
        user,
        idField,
        importAsDrafts,
      });
    } else {
      res = await getService('import').importData(dataRaw, {
        slug,
        format: actualFormat,
        user,
        idField,
        importAsDrafts,
      });
    }
  }

  ctx.body = {
    failures: res.failures,
  };
}

function hasPermissions(ctx) {
  const { data } = ctx.request.body;
  const {slug } = data
  const { userAbility } = ctx.state;

  let slugsToCheck = [];
  if (slug === CustomSlugs.WHOLE_DB) {
    slugsToCheck.push(...getAllSlugs());
  } else {
    slugsToCheck.push(slug);
  }

  return slugsToCheck.every((slug) => hasPermissionForSlug(userAbility, slug));
}

function hasPermissionForSlug(userAbility, slug) {
  
  const permissionChecker = strapi.plugin('content-manager').service('permission-checker').create({ userAbility, model: slug });

  return permissionChecker.can.create() && permissionChecker.can.update();
}
