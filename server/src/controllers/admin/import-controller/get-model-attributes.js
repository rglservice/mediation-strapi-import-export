import { getModelAttributes, getModel } from '../../../utils/models.js';

const getModelAttributesEndpoint = async (ctx) => {
  const { slug } = ctx.params;

  const attributeNames = getModelAttributes(slug)
    .filter(filterAttribute)
    .map((attr) => attr.name);

  attributeNames.unshift('id');

  // Get the model configuration to check for configured idField
  const model = getModel(slug);
  let idField = 'id'; // Default value
  
  // Check if the model has import-export plugin options configured
  if (model?.pluginOptions?.['strapi-import-export']?.idField) {
    idField = model.pluginOptions['strapi-import-export'].idField;
  }

  ctx.body = {
    data: {
      attribute_names: attributeNames,
      idField: idField,
    },
  };
};

const filterAttribute = (attr) => {
  const filters = [filterType, filterName];
  return filters.every((filter) => filter(attr));
};

const filterType = (attr) => !['relation', 'component', 'dynamiczone'].includes(attr.type);

const filterName = (attr) => !['createdAt', 'updatedAt', 'publishedAt', 'locale'].includes(attr.name);

export default ({ strapi }) => getModelAttributesEndpoint;
