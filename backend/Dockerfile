# syntax=docker/dockerfile:1

# ---- Build stage: JDK 21 + Maven wrapper ----
FROM eclipse-temurin:25-jdk-jammy AS build
WORKDIR /app

# Resolve dependencies first (cached layer when pom is unchanged)
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN chmod +x mvnw && ./mvnw -q -B dependency:go-offline

# Build the application jar
COPY src/ src/
RUN ./mvnw -q -B -DskipTests package

# ---- Runtime stage: slim JRE, non-root ----
FROM eclipse-temurin:25-jre-jammy AS runtime
WORKDIR /app

# Build provenance (TM-142): the git SHA the image was built from, surfaced at /version.
# Passed as a build-arg from GITHUB_SHA in CI; defaults to "dev" for a plain local build.
ARG GIT_SHA=dev
ENV BUILD_SHA=$GIT_SHA

# Non-root runtime user
RUN groupadd --system app && useradd --system --gid app --home-dir /app app

# Copy only the built jar from the build stage (no build tooling in final image)
COPY --from=build /app/target/backend-*.jar /app/app.jar

USER app

# Cloud Run injects PORT; Spring reads it via server.port=${PORT:8080}
ENV PORT=8080
ENV JAVA_OPTS=""
EXPOSE 8080

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
