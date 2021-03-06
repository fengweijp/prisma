import {
  Command,
  arg,
  getSchemaPath,
  getDMMF,
  getConfig,
  IntrospectionEngine,
  keyBy,
  pick,
} from '@prisma/sdk'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import { canConnectToDatabase } from '@prisma/migrate'
import { DMMF } from '@prisma/generator-helper'
import equal from 'fast-deep-equal'

const readFile = promisify(fs.readFile)
type IncorrectFieldTypes = Array<{
  localField: DMMF.Field
  remoteField: DMMF.Field
}>

/**
 * $ prisma version
 */
export class Doctor implements Command {
  static new(): Doctor {
    return new Doctor()
  }

  async parse(argv: string[]): Promise<string> {
    const args = arg(argv, {
      // '--help': Boolean,
      // '-h': '--help',
      '--schema': String,
    })

    const schemaPath = await getSchemaPath(args['--schema'])

    if (!schemaPath) {
      throw new Error(
        `Either provide ${chalk.greenBright(
          '--schema',
        )} or make sure that you are in a folder with a ${chalk.greenBright(
          'schema.prisma',
        )} file.`,
      )
    }

    const schema = await readFile(schemaPath, 'utf-8')
    const localDmmf = await getDMMF({ datamodel: schema })
    const config = await getConfig({ datamodel: schema })

    console.error(`👩‍⚕️🏥 Prisma Doctor checking the database...`)

    const connectionString = config.datasources[0].url
    const canConnect = await canConnectToDatabase(
      connectionString.value,
      path.dirname(schemaPath),
    )
    if (typeof canConnect !== 'boolean') {
      throw new Error(`${canConnect.code}: ${canConnect.message}`)
    }

    const engine = new IntrospectionEngine({
      cwd: path.dirname(schemaPath),
    })

    const { datamodel } = await engine.introspect(schema)
    const remoteDmmf = await getDMMF({ datamodel })

    const remoteModels = keyBy(
      remoteDmmf.datamodel.models,
      (m) => m.dbName ?? m.name,
    )

    const modelPairs = localDmmf.datamodel.models.map((localModel) => ({
      localModel,
      remoteModel: remoteModels[localModel.dbName ?? localModel.name],
    }))

    const getFieldName = (f: DMMF.Field) =>
      f.dbNames && f.dbNames.length > 0 ? f.dbNames[0] : f.name

    let messages: string[] = []

    for (const { localModel, remoteModel } of modelPairs) {
      let missingModel = false
      const missingFields: DMMF.Field[] = []
      const incorrectFieldType: IncorrectFieldTypes = []

      if (!remoteModel) {
        missingModel = true
      } else {
        const remoteFields = keyBy(remoteModel.fields, getFieldName)

        for (const localField of localModel.fields) {
          const remoteField = remoteFields[getFieldName(localField)]
          if (!remoteField) {
            missingFields.push(localField)
          } else if (
            !equal(
              pick(localField, ['type', 'isList']),
              pick(remoteField, ['type', 'isList']),
            )
          ) {
            incorrectFieldType.push({ localField, remoteField })
          }
        }
      }

      const msg = printModelMessage({
        model: localModel,
        missingModel,
        missingFields,
        incorrectFieldType,
      })
      if (msg) {
        messages.push(msg)
      }
    }

    if (messages.length > 0) {
      throw new Error('\n\n' + messages.join('\n\n'))
    }

    return `Everything in sync 🔄`
  }
}

function printModelMessage({
  model,
  missingModel,
  missingFields,
  incorrectFieldType,
}: {
  model: DMMF.Model
  missingModel: boolean
  missingFields: DMMF.Field[]
  incorrectFieldType: IncorrectFieldTypes
}) {
  if (
    !missingModel &&
    missingFields.length === 0 &&
    incorrectFieldType.length === 0
  ) {
    return null
  }
  let msg = `${chalk.bold.underline(model.name)}\n`
  if (missingModel) {
    msg += `↪ Model is missing in database\n`
  }

  for (const field of missingFields) {
    msg += `↪ Field ${chalk.bold(field.name)} is missing in database\n`
  }

  for (const { localField, remoteField } of incorrectFieldType) {
    const printField = (f: DMMF.Field) => f.name + (f.isList ? '[]' : '')
    msg += `↪ Field ${localField.name} has type ${chalk.greenBright(
      localField.type + printField(localField),
    )} locally, but ${chalk.redBright(printField(remoteField))} remote`
  }

  return msg
}
