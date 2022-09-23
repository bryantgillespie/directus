import type {
	Aggregate,
	ClientFilterOperator,
	FieldFunction,
	Filter,
	Query,
	Relation,
	SchemaOverview,
	Type,
} from '@directus/shared/types';
import type { Knex } from 'knex';
import { clone, isPlainObject, set } from 'lodash-es';
import { customAlphabet } from 'nanoid';
import validate from 'uuid-validate';
import { getHelpers } from '../database/helpers/index.js';
import { InvalidQueryException } from '../exceptions/invalid-query.js';
import { getColumn } from './get-column.js';
import { getColumnPath } from './get-column-path.js';
import { getRelationInfo } from './get-relation-info.js';
import { getFilterOperatorsForType, getOutputTypeForFunction } from '@directus/shared/utils';
import { stripFunction } from './strip-function.js';
import { map } from 'async';

const generateAlias = customAlphabet('abcdefghijklmnopqrstuvwxyz', 5);

/**
 * Apply the Query to a given Knex query builder instance
 */
export default async function applyQuery(
	knex: Knex,
	collection: string,
	dbQuery: Knex.QueryBuilder,
	query: Query,
	schema: SchemaOverview,
	subQuery = false
): Promise<Knex.QueryBuilder> {
	if (query.sort) {
		await applySort(knex, schema, dbQuery, query.sort, collection, subQuery);
	}

	if (typeof query.limit === 'number' && query.limit !== -1) {
		dbQuery.limit(query.limit);
	}

	if (query.offset) {
		dbQuery.offset(query.offset);
	}

	if (query.page && query.limit && query.limit !== -1) {
		dbQuery.offset(query.limit * (query.page - 1));
	}

	if (query.search) {
		await applySearch(schema, dbQuery, query.search, collection);
	}

	if (query.group) {
		const mapped = await map(query.group, async (column: string) => await getColumn(knex, collection, column, false, schema))

		dbQuery.groupBy(mapped);
	}

	if (query.aggregate) {
		applyAggregate(dbQuery, query.aggregate, collection);
	}

	if (query.filter) {
		await applyFilter(knex, schema, dbQuery, query.filter, collection, subQuery);
	}

	return dbQuery;
}

/**
 * Apply a given filter object to the Knex QueryBuilder instance.
 *
 * Relational nested filters, like the following example:
 *
 * ```json
 * // Fetch pages that have articles written by Rijk
 *
 * {
 *   "articles": {
 *     "author": {
 *       "name": {
 *         "_eq": "Rijk"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * are handled by joining the nested tables, and using a where statement on the top level on the
 * nested field through the join. This allows us to filter the top level items based on nested data.
 * The where on the root is done with a subquery to prevent duplicates, any nested joins are done
 * with aliases to prevent naming conflicts.
 *
 * The output SQL for the above would look something like:
 *
 * ```sql
 * SELECT *
 * FROM pages
 * WHERE
 *   pages.id in (
 *     SELECT articles.page_id AS page_id
 *     FROM articles
 *     LEFT JOIN authors AS xviqp ON articles.author = xviqp.id
 *     WHERE xviqp.name = 'Rijk'
 *   )
 * ```
 */

type AddJoinProps = {
	path: string[];
	collection: string;
	aliasMap: Record<string, string>;
	relations: Relation[];
	rootQuery: Knex.QueryBuilder;
	schema: SchemaOverview;
	subQuery: boolean;
	knex: Knex;
};

async function addJoin({ path, collection, aliasMap, rootQuery, subQuery, schema, relations, knex }: AddJoinProps) {
	path = clone(path);
	await followRelation(path);

	async function followRelation(pathParts: string[], parentCollection: string = collection, parentAlias?: string) {
		/**
		 * For A2M fields, the path can contain an optional collection scope <field>:<scope>
		 */
		const pathRoot = pathParts[0]!.split(':')[0]!;

		const { relation, relationType } = getRelationInfo(relations, parentCollection, pathRoot);

		if (!relation) {
			return;
		}

		const alias = generateAlias();
		const relatedCollectionInfo = await schema.getCollection(relation.related_collection!)

		set(aliasMap, parentAlias ? [parentAlias, ...pathParts] : pathParts, alias);

		if (relationType === 'm2o') {
			rootQuery.leftJoin(
				{ [alias]: relation.related_collection! },
				`${parentAlias || parentCollection}.${relation.field}`,
				`${alias}.${relatedCollectionInfo!.primary}`
			);
		}

		if (relationType === 'a2o') {
			const pathScope = pathParts[0]!.split(':')[1];

			if (!pathScope) {
				throw new InvalidQueryException(
					`You have to provide a collection scope when sorting or filtering on a many-to-any item`
				);
			}

			const collectionInfo = await schema.getCollection(pathScope)

			rootQuery.leftJoin({ [alias]: pathScope }, (joinClause) => {
				joinClause
					.onVal(relation.meta!.one_collection_field!, '=', pathScope)
					.andOn(
						`${parentAlias || parentCollection}.${relation.field}`,
						'=',
						knex.raw(`CAST(?? AS CHAR(255))`, `${alias}.${collectionInfo!.primary}`)
					);
			});
		}

		if (relationType === 'o2a') {

			const collectionInfo = await schema.getCollection(parentCollection)

			rootQuery.leftJoin({ [alias]: relation.collection }, (joinClause) => {
				joinClause
					.onVal(relation.meta!.one_collection_field!, '=', parentCollection)
					.andOn(
						`${alias}.${relation.field}`,
						'=',
						knex.raw(
							`CAST(?? AS CHAR(255))`,
							`${parentAlias || parentCollection}.${collectionInfo!.primary}`
						)
					);
			});
		}

		// Still join o2m relations when in subquery OR when the o2m relation is not at the root level
		if (relationType === 'o2m' && (subQuery === true || parentAlias !== undefined)) {
			rootQuery.leftJoin(
				{ [alias]: relation.collection },
				`${parentAlias || parentCollection}.${relatedCollectionInfo!.primary}`,
				`${alias}.${relation.field}`
			);
		}

		if (relationType === 'm2o' || subQuery === true || (relationType === 'o2m' && parentAlias !== undefined)) {
			let parent: string;

			if (relationType === 'm2o') {
				parent = relation.related_collection!;
			} else if (relationType === 'a2o') {
				const pathScope = pathParts[0]!.split(':')[1];

				if (!pathScope) {
					throw new InvalidQueryException(
						`You have to provide a collection scope when sorting or filtering on a many-to-any item`
					);
				}

				parent = pathScope;
			} else {
				parent = relation.collection;
			}

			pathParts.shift();
			if (pathParts.length) {
				await followRelation(pathParts, parent, alias);
			}
		}
	}
}

export async function applySort(
	knex: Knex,
	schema: SchemaOverview,
	rootQuery: Knex.QueryBuilder,
	rootSort: string[],
	collection: string,
	subQuery = false
) {
	const relations: Relation[] = await schema.getRelations();
	const aliasMap: Record<string, string> = {};

	const mapped = await map(rootSort, async (sortField: string) => {
		const column: string[] = sortField.split('.');
		let order: 'asc' | 'desc' = 'asc';

		if (column.length > 1) {
			if (sortField.startsWith('-')) {
				order = 'desc';
			}

			if (column[0]!.startsWith('-')) {
				column[0] = column[0]!.substring(1);
			}

			await addJoin({
				path: column,
				collection,
				aliasMap,
				rootQuery,
				subQuery,
				schema,
				relations,
				knex,
			});

			const { columnPath } = getColumnPath({ path: column, collection, aliasMap, relations });
			const [alias, field] = columnPath.split('.');

			return {
				order,
				column: await getColumn(knex, alias!, field!, false, schema) as any,
			};
		}

		let col = column[0];
		if (sortField.startsWith('-')) {
			col = column[0]!.substring(1);
			order = 'desc';
		}

		return {
			order,
			column: await getColumn(knex, collection, col!, false, schema) as any,
		};
	})

	rootQuery.orderBy(mapped);
}

export async function applyFilter(
	knex: Knex,
	schema: SchemaOverview,
	rootQuery: Knex.QueryBuilder,
	rootFilter: Filter,
	collection: string,
	subQuery = false
) {
	const helpers = getHelpers(knex);
	const relations: Relation[] = await schema.getRelations();

	const aliasMap: Record<string, string> = {};

	await addJoins(rootQuery, rootFilter, collection);
	await addWhereClauses(knex, rootQuery, rootFilter, collection);

	return rootQuery;

	async function addJoins(dbQuery: Knex.QueryBuilder, filter: Filter, collection: string) {
		for (const [key, value] of Object.entries(filter)) {
			if (key === '_or' || key === '_and') {
				// If the _or array contains an empty object (full permissions), we should short-circuit and ignore all other
				// permission checks, as {} already matches full permissions.
				if (key === '_or' && value.some((subFilter: Record<string, any>) => Object.keys(subFilter).length === 0))
					continue;

				for (const subFilter of value) {
					await addJoins(dbQuery, subFilter, collection);
				}

				continue;
			}

			const filterPath = getFilterPath(key, value);
			if (filterPath.length > 1) {
				await addJoin({
					path: filterPath,
					collection,
					knex,
					schema,
					relations,
					subQuery,
					rootQuery,
					aliasMap,
				});
			}
		}
	}

	async function addWhereClauses(
		knex: Knex,
		dbQuery: Knex.QueryBuilder,
		filter: Filter,
		collection: string,
		logical: 'and' | 'or' = 'and'
	) {
		for (const [key, value] of Object.entries(filter)) {
			if (key === '_or' || key === '_and') {
				// If the _or array contains an empty object (full permissions), we should short-circuit and ignore all other
				// permission checks, as {} already matches full permissions.
				if (key === '_or' && value.some((subFilter: Record<string, any>) => Object.keys(subFilter).length === 0)) {
					continue;
				}

				for (const subFilter of value) {
					// TODO: Test if this change actually works on all cases
					await addWhereClauses(knex, dbQuery, subFilter, collection, key === '_and' ? 'and' : 'or');
				}

				continue;
			}

			const filterPath = getFilterPath(key, value);

			/**
			 * For A2M fields, the path can contain an optional collection scope <field>:<scope>
			 */
			const pathRoot = filterPath[0]!.split(':')[0]!;

			const { relation, relationType } = getRelationInfo(relations, collection, pathRoot);

			const { operator: filterOperator, value: filterValue } = getOperation(key, value);

			if (relationType === 'm2o' || relationType === 'a2o' || relationType === null) {
				if (filterPath.length > 1) {
					const { columnPath, targetCollection } = getColumnPath({ path: filterPath, collection, relations, aliasMap });

					if (!columnPath) continue;

					const field = await schema.getField(targetCollection, stripFunction(filterPath[filterPath.length - 1]!));

					validateFilterOperator(field!.type, filterOperator, field!.special);

					await applyFilterToQuery(columnPath, filterOperator, filterValue, logical, targetCollection);
				} else {
					const field = await schema.getField(collection, stripFunction(filterPath[0]!));

					validateFilterOperator(field!.type, filterOperator, field!.special);

					await applyFilterToQuery(`${collection}.${filterPath[0]}`, filterOperator, filterValue, logical);
				}
			} else if (subQuery === false || filterPath.length > 1) {
				if (!relation) continue;

				const collectionInfo = await schema.getCollection(relation!.related_collection!)

				let pkField: Knex.Raw<any> | string = `${collection}.${collectionInfo!.primary}`;

				if (relationType === 'o2a') {
					pkField = knex.raw(`CAST(?? AS CHAR(255))`, [pkField]);
				}

				const subQueryBuilder = (filter: Filter) => async (subQueryKnex: Knex.QueryBuilder<any, unknown[]>) => {
					const field = relation!.field;
					const collection = relation!.collection;
					const column = `${collection}.${field}`;

					subQueryKnex
						.select({ [field]: column })
						.from(collection)
						.whereNotNull(column);

					await applyQuery(knex, relation!.collection, subQueryKnex, { filter }, schema, true);
				};

				// TODO: this wont work as it is async and whereNotIn probably doesn't support async
				if (Object.keys(value)?.[0] === '_none') {
					dbQuery[logical].whereNotIn(pkField as string, subQueryBuilder(Object.values(value)[0] as Filter));
				} else if (Object.keys(value)?.[0] === '_some') {
					dbQuery[logical].whereIn(pkField as string, subQueryBuilder(Object.values(value)[0] as Filter));
				} else {
					dbQuery[logical].whereIn(pkField as string, subQueryBuilder(value));
				}
			}
		}

		function validateFilterOperator(type: Type, filterOperator: string, special: string[]) {
			if (filterOperator.startsWith('_')) {
				filterOperator = filterOperator.slice(1);
			}

			if (!getFilterOperatorsForType(type).includes(filterOperator as ClientFilterOperator)) {
				throw new InvalidQueryException(
					`"${type}" field type does not contain the "_${filterOperator}" filter operator`
				);
			}

			if (
				special.includes('conceal') &&
				!getFilterOperatorsForType('hash').includes(filterOperator as ClientFilterOperator)
			) {
				throw new InvalidQueryException(
					`Field with "conceal" special does not allow the "_${filterOperator}" filter operator`
				);
			}
		}

		async function applyFilterToQuery(
			key: string,
			operator: string,
			compareValue: any,
			logical: 'and' | 'or' = 'and',
			originalCollectionName?: string
		) {
			const [table, column] = key.split('.');

			// Is processed through Knex.Raw, so should be safe to string-inject into these where queries
			const selectionRaw = await getColumn(knex, table!, column!, false, schema) as any;

			// Knex supports "raw" in the columnName parameter, but isn't typed as such. Too bad..
			// See https://github.com/knex/knex/issues/4518 @TODO remove as any once knex is updated

			// These operators don't rely on a value, and can thus be used without one (eg `?filter[field][_null]`)
			if (operator === '_null' || (operator === '_nnull' && compareValue === false)) {
				dbQuery[logical].whereNull(selectionRaw);
			}

			if (operator === '_nnull' || (operator === '_null' && compareValue === false)) {
				dbQuery[logical].whereNotNull(selectionRaw);
			}

			if (operator === '_empty' || (operator === '_nempty' && compareValue === false)) {
				dbQuery[logical].andWhere((query) => {
					query.where(key, '=', '');
				});
			}

			if (operator === '_nempty' || (operator === '_empty' && compareValue === false)) {
				dbQuery[logical].andWhere((query) => {
					query.where(key, '!=', '');
				});
			}

			// The following fields however, require a value to be run. If no value is passed, we
			// ignore them. This allows easier use in GraphQL, where you wouldn't be able to
			// conditionally build out your filter structure (#4471)
			if (compareValue === undefined) return;

			if (Array.isArray(compareValue)) {
				// Tip: when using a `[Type]` type in GraphQL, but don't provide the variable, it'll be
				// reported as [undefined].
				// We need to remove any undefined values, as they are useless
				compareValue = compareValue.filter((val) => val !== undefined);
			}

			// Cast filter value (compareValue) based on function used
			if (column!.includes('(') && column!.includes(')')) {
				const functionName = column!.split('(')[0] as FieldFunction;
				const type = getOutputTypeForFunction(functionName);

				if (['bigInteger', 'integer', 'float', 'decimal'].includes(type)) {
					compareValue = Number(compareValue);
				}
			}

			// Cast filter value (compareValue) based on type of field being filtered against
			const [collection, field] = key.split('.');
			const mappedCollection = originalCollectionName || collection!;

			const fieldInfo = await schema.getField(mappedCollection, field!)

			if (fieldInfo !== null) {

				if (['date', 'dateTime', 'time', 'timestamp'].includes(fieldInfo.type)) {
					if (Array.isArray(compareValue)) {
						compareValue = compareValue.map((val) => helpers.date.parse(val));
					} else {
						compareValue = helpers.date.parse(compareValue);
					}
				}

				if (['bigInteger', 'integer', 'float', 'decimal'].includes(fieldInfo.type)) {
					if (Array.isArray(compareValue)) {
						compareValue = compareValue.map((val) => Number(val));
					} else {
						compareValue = Number(compareValue);
					}
				}
			}

			if (operator === '_eq') {
				dbQuery[logical].where(selectionRaw, '=', compareValue);
			}

			if (operator === '_neq') {
				dbQuery[logical].whereNot(selectionRaw, compareValue);
			}

			if (operator === '_ieq') {
				dbQuery[logical].whereRaw(`LOWER(??) = ?`, [selectionRaw, `${compareValue.toLowerCase()}`]);
			}

			if (operator === '_nieq') {
				dbQuery[logical].whereRaw(`LOWER(??) <> ?`, [selectionRaw, `${compareValue.toLowerCase()}`]);
			}

			if (operator === '_contains') {
				dbQuery[logical].where(selectionRaw, 'like', `%${compareValue}%`);
			}

			if (operator === '_ncontains') {
				dbQuery[logical].whereNot(selectionRaw, 'like', `%${compareValue}%`);
			}

			if (operator === '_icontains') {
				dbQuery[logical].whereRaw(`LOWER(??) LIKE ?`, [selectionRaw, `%${compareValue.toLowerCase()}%`]);
			}

			if (operator === '_nicontains') {
				dbQuery[logical].whereRaw(`LOWER(??) NOT LIKE ?`, [selectionRaw, `%${compareValue.toLowerCase()}%`]);
			}

			if (operator === '_starts_with') {
				dbQuery[logical].where(key, 'like', `${compareValue}%`);
			}

			if (operator === '_nstarts_with') {
				dbQuery[logical].whereNot(key, 'like', `${compareValue}%`);
			}

			if (operator === '_istarts_with') {
				dbQuery[logical].whereRaw(`LOWER(??) LIKE ?`, [selectionRaw, `${compareValue.toLowerCase()}%`]);
			}

			if (operator === '_nistarts_with') {
				dbQuery[logical].whereRaw(`LOWER(??) NOT LIKE ?`, [selectionRaw, `${compareValue.toLowerCase()}%`]);
			}

			if (operator === '_ends_with') {
				dbQuery[logical].where(key, 'like', `%${compareValue}`);
			}

			if (operator === '_nends_with') {
				dbQuery[logical].whereNot(key, 'like', `%${compareValue}`);
			}

			if (operator === '_iends_with') {
				dbQuery[logical].whereRaw(`LOWER(??) LIKE ?`, [selectionRaw, `%${compareValue.toLowerCase()}`]);
			}

			if (operator === '_niends_with') {
				dbQuery[logical].whereRaw(`LOWER(??) NOT LIKE ?`, [selectionRaw, `%${compareValue.toLowerCase()}`]);
			}

			if (operator === '_gt') {
				dbQuery[logical].where(selectionRaw, '>', compareValue);
			}

			if (operator === '_gte') {
				dbQuery[logical].where(selectionRaw, '>=', compareValue);
			}

			if (operator === '_lt') {
				dbQuery[logical].where(selectionRaw, '<', compareValue);
			}

			if (operator === '_lte') {
				dbQuery[logical].where(selectionRaw, '<=', compareValue);
			}

			if (operator === '_in') {
				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereIn(selectionRaw, value as string[]);
			}

			if (operator === '_nin') {
				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereNotIn(selectionRaw, value as string[]);
			}

			if (operator === '_between') {
				if (compareValue.length !== 2) return;

				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereBetween(selectionRaw, value);
			}

			if (operator === '_nbetween') {
				if (compareValue.length !== 2) return;

				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereNotBetween(selectionRaw, value);
			}

			if (operator == '_intersects') {
				dbQuery[logical].whereRaw(helpers.st.intersects(key, compareValue));
			}

			if (operator == '_nintersects') {
				dbQuery[logical].whereRaw(helpers.st.nintersects(key, compareValue));
			}

			if (operator == '_intersects_bbox') {
				dbQuery[logical].whereRaw(helpers.st.intersects_bbox(key, compareValue));
			}

			if (operator == '_nintersects_bbox') {
				dbQuery[logical].whereRaw(helpers.st.nintersects_bbox(key, compareValue));
			}
		}
	}
}

export async function applySearch(
	schema: SchemaOverview,
	dbQuery: Knex.QueryBuilder,
	searchQuery: string,
	collection: string
): Promise<void> {
	const fields = Object.entries(await schema.getFields(collection));

	dbQuery.andWhere(function () {
		fields.forEach(([name, field]) => {
			if (['text', 'string'].includes(field.type)) {
				this.orWhereRaw(`LOWER(??) LIKE ?`, [`${collection}.${name}`, `%${searchQuery.toLowerCase()}%`]);
			} else if (['bigInteger', 'integer', 'decimal', 'float'].includes(field.type)) {
				const number = Number(searchQuery);
				if (!isNaN(number)) this.orWhere({ [`${collection}.${name}`]: number });
			} else if (field.type === 'uuid' && validate(searchQuery)) {
				this.orWhere({ [`${collection}.${name}`]: searchQuery });
			}
		});
	});
}

export function applyAggregate(dbQuery: Knex.QueryBuilder, aggregate: Aggregate, collection: string): void {
	for (const [operation, fields] of Object.entries(aggregate)) {
		if (!fields) continue;

		for (const field of fields) {
			if (operation === 'avg') {
				dbQuery.avg(`${collection}.${field}`, { as: `avg->${field}` });
			}

			if (operation === 'avgDistinct') {
				dbQuery.avgDistinct(`${collection}.${field}`, { as: `avgDistinct->${field}` });
			}

			if (operation === 'countAll') {
				dbQuery.count('*', { as: 'countAll' });
			}

			if (operation === 'count') {
				if (field === '*') {
					dbQuery.count('*', { as: 'count' });
				} else {
					dbQuery.count(`${collection}.${field}`, { as: `count->${field}` });
				}
			}

			if (operation === 'countDistinct') {
				dbQuery.countDistinct(`${collection}.${field}`, { as: `countDistinct->${field}` });
			}

			if (operation === 'sum') {
				dbQuery.sum(`${collection}.${field}`, { as: `sum->${field}` });
			}

			if (operation === 'sumDistinct') {
				dbQuery.sumDistinct(`${collection}.${field}`, { as: `sumDistinct->${field}` });
			}

			if (operation === 'min') {
				dbQuery.min(`${collection}.${field}`, { as: `min->${field}` });
			}

			if (operation === 'max') {
				dbQuery.max(`${collection}.${field}`, { as: `max->${field}` });
			}
		}
	}
}

function getFilterPath(key: string, value: Record<string, any>) {
	const path = [key];

	if (typeof Object.keys(value)[0] === 'string' && Object.keys(value)[0]!.startsWith('_') === true) {
		return path;
	}

	if (isPlainObject(value)) {
		path.push(...getFilterPath(Object.keys(value)[0]!, Object.values(value)[0]));
	}

	return path;
}

function getOperation(key: string, value: Record<string, any>): { operator: string; value: any } {
	if (key.startsWith('_') && key !== '_and' && key !== '_or') {
		return { operator: key as string, value };
	} else if (isPlainObject(value) === false) {
		return { operator: '_eq', value };
	}

	return getOperation(Object.keys(value)[0]!, Object.values(value)[0]);
}
